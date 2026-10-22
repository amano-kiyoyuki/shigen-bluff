(function(root){
  'use strict';
  const ORDER=['fire','water','earth','wind'],START={fire:2,water:2,earth:2,wind:2},POINTS={fire:10,water:10,earth:10,wind:10};
  const LEAD=1200,CHOOSE=5000,REVEAL=5000,SETTLE=1000,HOLD=5200,STRIDE=CHOOSE+REVEAL+SETTLE+HOLD,TTL=900000;
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o||{},k);
  const obj=o=>o&&typeof o==='object';
  const integer=n=>Number.isSafeInteger(n)&&n>=0;
  const text=s=>typeof s==='string'&&s.length>0&&s.length<=10;
  function checkRoom(room){
    if(!obj(room)||!obj(room.meta)||typeof room.meta.owner!=='string'||typeof room.meta.public!=='boolean'||!integer(room.meta.createdAt))return false;
    const slots=room.slots||{};
    if(Object.keys(slots).some(k=>!['0','1'].includes(k)))return false;
    const list=Object.values(slots).filter(Boolean);
    if(!list.every(p=>typeof p.uid==='string'&&p.uid.length>0&&text(p.name)&&integer(p.joinedAt))||new Set(list.map(p=>p.uid)).size!==list.length)return false;
    if(!room.match)return true;
    const m=room.match;
    if(!/^[a-f0-9]{32}$/.test(m.id)||!integer(m.startAt)||!obj(m.seats))return false;
    const seats=Object.values(m.seats).filter(Boolean);
    if(seats.length!==2||Object.keys(m.seats).some(k=>!['0','1'].includes(k)))return false;
    return Object.entries(m.seats).filter(([,p])=>p!=null).every(([k,p])=>typeof p.uid==='string'&&text(p.name)&&slots[k]?.uid===p.uid&&slots[k]?.name===p.name)&&seats.length===list.length;
  }
  const begin=(match,round)=>match.startAt+LEAD+(round-1)*STRIDE;
  function scoreDuel(a,b){
    if(a===b)return [0,0];
    if((a==='fire'&&b==='water')||(a==='water'&&b==='earth')||(a==='earth'&&b==='wind')||(a==='wind'&&b==='fire'))return [Math.round(POINTS[a]*1.5),0];
    if((b==='fire'&&a==='water')||(b==='water'&&a==='earth')||(b==='earth'&&a==='wind')||(b==='wind'&&a==='fire'))return [0,Math.round(POINTS[b]*1.5)];
    return [POINTS[a],POINTS[b]];
  }
  function phase(match,now){
    const elapsed=now-match.startAt-LEAD;
    const round=Math.max(1,Math.min(5,Math.floor(elapsed/STRIDE)+1));
    if(elapsed>=5*STRIDE)return {round:5,stage:'end'};
    const t=now-begin(match,round);
    return {round,stage:t<0?'lead':t<CHOOSE?'choose':t<CHOOSE+REVEAL?'opening':t<CHOOSE+REVEAL+SETTLE?'settling':'result'};
  }
  function nonce(bytes=32,cryptoImpl=root.crypto){
    const a=new Uint8Array(bytes);cryptoImpl.getRandomValues(a);return Array.from(a,x=>x.toString(16).padStart(2,'0')).join('');
  }
  async function commitment(code,matchId,round,uid,reveal,cryptoImpl=root.crypto){
    const data=JSON.stringify(['shigen-bluff/spark-v2',code,matchId,round,uid,reveal.card,reveal.nonce,reveal.timed]);
    const hash=await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(data));
    return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
  }
  async function derive(code,room,now,cryptoImpl=root.crypto){
    if(!checkRoom(room))return {status:'invalid',reason:'対戦データの形式を確認できません'};
    if(now>=room.meta.createdAt+TTL)return {status:'expired'};
    if(!room.match)return {status:'lobby'};
    const m=room.match,seats=Object.entries(m.seats).filter(([,p])=>p!=null).sort(([a],[b])=>Number(a)-Number(b)).map(([,p])=>({...p,type:'human'}));
    const hands=seats.map(()=>({...START})),scores=seats.map(()=>0),history=[];
    const state=phase(m,now);
    const completed=state.stage==='end'?5:state.round-(['result'].includes(state.stage)?0:1);
    for(let r=1;r<=completed;r++){
      const round=room.rounds?.[r]||{},choices=[];
      for(let i=0;i<seats.length;i++){
        const uid=seats[i].uid,hash=round.commits?.[uid],reveal=round.reveals?.[uid];
        let reason='';
        if(typeof hash!=='string')reason='カードの確定を受信できませんでした';
        else if(!reveal)reason='カードの公開を受信できませんでした';
        else if(!ORDER.includes(reveal.card)||!(/^[a-f0-9]{64}$/.test(reveal.nonce))||typeof reveal.timed!=='boolean')reason='カードの形式が正しくありません';
        else if(await commitment(code,m.id,r,uid,reveal,cryptoImpl)!==hash)reason='確定したカードと公開されたカードが一致しません';
        else if(hands[i][reveal.card]<=0)reason='残っていないカードが出されました';
        if(reason)return {status:'aborted',round:r,reason};
        choices.push(reveal);
      }
      const a=choices[0].card,b=choices[1].card;
      const points=scoreDuel(a,b);
      const rec=choices.map((c,i)=>({el:c.card,col:a===b,pts:points[i],timed:c.timed}));
      rec.forEach((v,i)=>{hands[i][v.el]--;scores[i]+=v.pts;});history.push(rec);
    }
    return {status:state.stage==='end'?'end':'playing',stage:state.stage,round:state.round,gid:m.id,seats,hands,scores,history,rec:history[state.round-1]||null,roundStart:begin(m,state.round),deadline:begin(m,state.round)+CHOOSE,revealAt:begin(m,state.round)+CHOOSE+REVEAL+SETTLE};
  }
  const api={ORDER,START,POINTS,LEAD,CHOOSE,REVEAL,SETTLE,HOLD,STRIDE,TTL,checkRoom,begin,phase,nonce,commitment,derive,scoreDuel,own};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SparkProtocol=api;
})(typeof globalThis==='object'?globalThis:this);
