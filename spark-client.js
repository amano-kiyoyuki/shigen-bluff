(function(root){
  'use strict';
  const P=typeof module==='object'&&module.exports?require('./spark-protocol.js'):root.SparkProtocol;
  class SparkClient {
    constructor({db,uid,clock=Date.now,storage=root.localStorage,crypto=root.crypto,timestamp={'.sv':'timestamp'}}){
      Object.assign(this,{db,uid,clock,storage,crypto,timestamp});this.code=null;this.off=null;this.presence=null;
    }
    ref(code=this.code){return this.db.ref(`sparkV2/rooms/${code}`);}
    async create(name,isPublic=false){
      let code;
      for(let i=0;i<12;i++){
        const bytes=new Uint8Array(4);this.crypto.getRandomValues(bytes);const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        code=Array.from(bytes,b=>alphabet[b%alphabet.length]).join('');
        const meta=(await this.ref(code).child('meta').once('value')).val();
        if(!meta)break;
        if(this.clock()>=meta.createdAt+P.TTL){await this.ref(code).remove();break;}
        code=null;
      }
      if(!code)throw new Error('busy');
      await this.db.ref(`sparkV2/tickets/${this.uid}`).set({at:this.timestamp,code});
      await this.ref(code).set({meta:{owner:this.uid,public:!!isPublic,createdAt:this.timestamp},slots:{0:{uid:this.uid,name,joinedAt:this.timestamp}}});
      this.code=code;
      const room=await this.read();
      if(isPublic)await this.db.ref(`sparkV2/lobby/${code}`).set({createdAt:room.meta.createdAt,owner:this.uid});
      return {code,room};
    }
    async enter(code,name){
      const ref=this.ref(code),meta=(await ref.child('meta').once('value')).val();
      if(!meta)throw new Error('notfound');
      if(this.clock()>=meta.createdAt+P.TTL)throw new Error('expired');
      // Existing members can resume without rewriting their immutable seat.
      try{const room=(await ref.once('value')).val();if(Object.values(room?.slots||{}).some(p=>p?.uid===this.uid)){this.code=code;return {code,room};}}catch(e){if(!/permission/i.test(e.code||e.message))throw e;}
      for(let slot=0;slot<2;slot++){
        try{await ref.child(`slots/${slot}`).set({uid:this.uid,name,joinedAt:this.timestamp});this.code=code;return {code,room:await this.read()};}
        catch(e){if(!/permission/i.test(e.code||e.message))throw e;}
      }
      throw new Error('full-or-started');
    }
    async random(name){
      const snap=await this.db.ref('sparkV2/lobby').orderByChild('createdAt').limitToLast(30).once('value');
      const list=[];snap.forEach(s=>list.push({code:s.key,...s.val()}));
      for(const item of list.reverse()){
        if(this.clock()>=item.createdAt+P.TTL){
          await this.db.ref(`sparkV2/lobby/${item.code}`).remove().catch(()=>{});
          await this.ref(item.code).remove().catch(()=>{});continue;
        }
        try{return await this.enter(item.code,name);}catch(e){if(!['notfound','expired','full-or-started'].includes(e.message))throw e;}
      }
      return this.create(name,true);
    }
    async read(){return (await this.ref().once('value')).val();}
    watch(onRoom,onError){
      if(this.off)this.off();
      const ref=this.ref(),cb=s=>onRoom(s.val());ref.on('value',cb,onError);this.off=()=>ref.off('value',cb);
    }
    async connected(){
      if(!this.code)return;
      const presence=this.ref().child(`presence/${this.uid}`);this.presence=presence;
      await presence.onDisconnect().set(false);await presence.set(true);
    }
    async start(){
      const room=await this.read();
      const seats=Object.fromEntries(Object.entries(room.slots||{}).filter(([,p])=>p).map(([k,p])=>[k,{uid:p.uid,name:p.name}]));
      if(Object.keys(seats).length!==2)throw new Error('need-two');
      await this.ref().child('match').set({id:P.nonce(16,this.crypto),startAt:this.timestamp,seats});
      await this.db.ref(`sparkV2/lobby/${this.code}`).remove().catch(()=>{});
    }
    key(match,round,hash){return `shigen:secret:v2:${this.uid}:${this.code}:${match.id}:${round}:${hash}`;}
    secret(room,round){
      const hash=room.rounds?.[round]?.commits?.[this.uid];if(!hash)return null;
      try{return JSON.parse(this.storage.getItem(this.key(room.match,round,hash)));}catch(_){return null;}
    }
    async submit(room,round,card,timed=false){
      if(!room?.match||P.phase(room.match,this.clock()).stage!=='choose'||P.phase(room.match,this.clock()).round!==round)throw new Error('closed');
      if(room.rounds?.[round]?.commits?.[this.uid])throw new Error('already-picked');
      if(!P.ORDER.includes(card))throw new Error('invalid-card');
      const reveal={card,nonce:P.nonce(32,this.crypto),timed:!!timed};
      const hash=await P.commitment(this.code,room.match.id,round,this.uid,reveal,this.crypto);
      // Persist first. The key includes the hash so another tab cannot overwrite this choice.
      const key=this.key(room.match,round,hash),saved=JSON.stringify(reveal);
      this.storage.setItem(key,saved);
      if(this.storage.getItem(key)!==saved)throw new Error('storage-unavailable');
      const ref=this.ref().child(`rounds/${round}/commits/${this.uid}`);
      try{await ref.set(hash);}catch(e){if((await ref.once('value')).val()!==hash)throw e;}
      return reveal;
    }
    async reveal(room){
      if(!room?.match)return;
      const {stage,round}=P.phase(room.match,this.clock());
      if(stage!=='opening'||!room.rounds?.[round]?.commits?.[this.uid]||room.rounds?.[round]?.reveals?.[this.uid])return;
      const reveal=this.secret(room,round);if(!reveal)return;
      await this.ref().child(`rounds/${round}/reveals/${this.uid}`).set(reveal);
    }
    forget(room){
      if(!room?.match)return;
      const prefix=`shigen:secret:v2:${this.uid}:${this.code}:${room.match.id}:`;
      try{for(let i=this.storage.length-1;i>=0;i--){const key=this.storage.key(i);if(key?.startsWith(prefix))this.storage.removeItem(key);}}catch(_){}
    }
    async leave(room){
      if(this.off)this.off();this.off=null;
      if(!this.code)return;
      // A running match is immutable; leaving cannot erase submitted evidence.
      if(this.presence){await this.presence.set(false).catch(()=>{});await this.presence.onDisconnect().cancel().catch(()=>{});this.presence=null;}
      if(!room?.match){const own=Object.entries(room?.slots||{}).find(([,p])=>p?.uid===this.uid);if(own)await this.ref().child(`slots/${own[0]}`).remove().catch(()=>{});}
      this.code=null;
    }
  }
  if(typeof module==='object'&&module.exports)module.exports=SparkClient;else root.SparkClient=SparkClient;
})(typeof globalThis==='object'?globalThis:this);
