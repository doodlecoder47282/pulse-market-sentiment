import { test } from "node:test";
import assert from "node:assert/strict";
import { exactContractMention, readSocialTokenEvidence, selectSocialBatch } from "../server/cryptoSocial";
import { socialEvidenceFresh } from "../shared/cryptoSocial";

const mint = "3jcc99pP2ND2Rmv2gZYDBb2JiWRuB4d7H11Rhtenpump";
const now = Date.parse("2026-10-01T14:00:00Z");
function post(n: number, text = mint, age = 1000) {
  return { uri: `at://did:plc:author${n}/app.bsky.feed.post/key${n}`,
    author: { did: `did:plc:author${n}` }, record: { text, createdAt: new Date(now - age).toISOString() } };
}
test("contract matching is case-sensitive, bounded and does not trust cashtags", () => {
  assert.equal(exactContractMention(post(1, `$TEST CA: ${mint}`),mint),true);
  for(const text of [`${mint}A`,`A${mint}`,mint.toLowerCase(),"$TEST","just research"]) {
    assert.equal(exactContractMention(post(1,text),mint),false,text);
  }
});
test("recognized token links may identify the mint; arbitrary links, userinfo and prefixes do not", () => {
  for(const [url,expected] of [
    [`https://pump.fun/coin/${mint}`,true], [`https://solscan.io/token/${mint}`,true],
    [`https://jup.ag/swap/SOL-${mint}`,false], [`https://evil.test/token/${mint}`,false],
    [`https://pump.fun.evil.test/${mint}`,false], [`https://x@pump.fun/${mint}`,false],
    [`javascript:${mint}`,false], [`https://pump.fun/${mint}A`,false],
  ] as const) {
    const p:any=post(1,"shortened link");
    p.record.facets=[{features:[{$type:"app.bsky.richtext.facet#link",uri:url}]}];
    assert.equal(exactContractMention(p,mint),expected,url);
  }
});
test("two bounded queries separate token evidence from disjoint ticker-only chatter", async () => {
  const urls:string[]=[];
  const r=await readSocialTokenEvidence("TEST",mint,now,async u=>{
    urls.push(u);const q=new URL(u).searchParams.get("q");
    return {posts:q===mint?[post(1),post(1),post(2,"$TEST"),post(3,"else")]:
      [post(1,`${mint} $TEST`),post(4,"$TEST"),post(5,"$TESTING"),post(6,"TEST")]};
  });
  assert.equal(urls.length,2);
  for(const u of urls){const q=new URL(u).searchParams;assert.equal(q.get("limit"),"100");assert.equal(q.get("since"),new Date(now-3600000).toISOString());}
  assert.equal(r.contract.mentions1h,1);assert.equal(r.ticker?.mentions1h,1);
  assert.equal(r.contract.uniqueAuthors1h,1);assert.equal(r.receipts.length,2);
  assert.match(r.receipts[0].url,/^https:\/\/bsky.app\/profile\/did%3Aplc%3Aauthor1\/post\/key1$/);
  assert.match(r.ticker!.identity,/excluded from score/);
});
test("valid zero differs from malformed, future and identity-mismatched posts", async () => {
  const empty=await readSocialTokenEvidence("币",mint,now,async()=>({posts:[]}));
  assert.equal(empty.contract.mentions1h,0);assert.equal(empty.contract.timestampsComplete,true);
  assert.equal(empty.ticker,null);assert.equal(empty.queryGap,false);
  const bad=post(1);bad.author.did="did:plc:wrong";
  const r=await readSocialTokenEvidence("币",mint,now,async()=>({posts:[bad,post(2,mint,-1000),post(3,mint,3600001)]}));
  assert.equal(r.contract.mentions1h,0);assert.equal(r.contract.timestampsComplete,false);
  await assert.rejects(readSocialTokenEvidence("币",mint,now,async()=>({error:"bad"})),/Invalid/);
});
test("ticker query failure retains contract observations but never full coverage", async () => {
  let n=0;const r=await readSocialTokenEvidence("TEST",mint,now,async()=>{if(++n===2)throw Error("429");return {posts:[post(1)]};});
  assert.equal(r.contract.mentions1h,1);assert.equal(r.queryGap,true);assert.equal(r.ticker,null);
  assert.match(r.tickerReason,/unavailable/);
});
test("contract denial stops before ticker request and invalid mint stops before all requests", async () => {
  let n=0;
  await assert.rejects(readSocialTokenEvidence("TEST",mint,now,async()=>{n++;throw Error("403");}),/403/);
  assert.equal(n,1);
  await assert.rejects(readSocialTokenEvidence("TEST","invalid",now,async()=>{n++;return{posts:[]};}),/Invalid Solana/);
  assert.equal(n,1);
});
test("non-overlapping pace windows have a minimum evidence gate, not an infinite zero baseline", async () => {
  const rows=[post(1,mint,1000),post(2,mint,2000),post(3,mint,3000),
    post(4,mint,600000),post(5,mint,800000),post(6,mint,1199999),post(7,mint,1200000)];
  const r=await readSocialTokenEvidence("币",mint,now,async()=>({posts:rows}));
  assert.equal(r.pace.current10m,3);assert.equal(r.pace.previous10m,3);
  assert.equal(r.pace.state,"sampled");assert.equal(r.pace.ratio,1);assert.equal(r.pace.delta,0);
  const low=await readSocialTokenEvidence("币",mint,now,async()=>({posts:[post(1)]}));
  assert.equal(low.pace.ratio,null);assert.equal(low.pace.delta,null);assert.equal(low.pace.state,"insufficient");
});
test("cap, malformed sample, and low author diversity prevent a pace verdict", async () => {
  const rows=Array.from({length:12},(_,n)=>post(n,mint,n<6?1000:700000));
  const capped=await readSocialTokenEvidence("币",mint,now,async()=>({posts:rows,cursor:"more"}));
  assert.equal(capped.contract.capped,true);assert.equal(capped.pace.ratio,null);
  const invalid=await readSocialTokenEvidence("币",mint,now,async()=>({posts:[...rows,{uri:"bad"}]}));
  assert.equal(invalid.pace.ratio,null);
  const same=rows.map((p,n)=>({...p,uri:`at://did:plc:same/app.bsky.feed.post/key${n}`,author:{did:"did:plc:same"}}));
  const oneAuthor=await readSocialTokenEvidence("币",mint,now,async()=>({posts:same}));
  assert.equal(oneAuthor.contract.uniqueAuthors1h,1);assert.equal(oneAuthor.pace.ratio,null);
});
test("receipts are bounded escaped-data candidates, with no requested remote URL fetch", async () => {
  const urls:string[]=[];
  const r=await readSocialTokenEvidence("TEST",mint,now,async u=>{
    urls.push(u);return {posts:Array.from({length:10},(_,i)=>post(i,new URL(u).searchParams.get("q")===mint?`${mint} <script>alert(1)</script>`:"$TEST ticker"))};
  });
  assert.equal(r.receipts.length,6);assert.ok(r.receipts.every(r=>r.url.startsWith("https://bsky.app/")));
  assert.equal(urls.length,2);assert.ok(urls.every(u=>u.startsWith("https://api.bsky.app/xrpc/")));
});
test("expiry and incompatible versions withdraw cached social detail", async () => {
  const e=await readSocialTokenEvidence("币",mint,now,async()=>({posts:[]}));
  assert.equal(socialEvidenceFresh(e,now),true);assert.equal(socialEvidenceFresh(e,now+600001),false);
  assert.equal(socialEvidenceFresh(e,now-1),false);assert.equal(socialEvidenceFresh({...e,version:"old"},now),false);
});
test("selection has priority plus oldest-first, excludes bad market data and deduplicates mints", () => {
  const rows=Array.from({length:10},(_,i)=>({tokenAddress:`${i+1}${mint.slice(1)}`,lastRefreshAt:now,marketCap:100000,
    liquidityUsd:10000,hardKill:false,score:i>4?50:10,socialAttemptAt:null as number|null}));
  const selected=selectSocialBatch([rows[5],rows[5],...rows],now,2000000);
  assert.equal(selected.length,4);assert.equal(new Set(selected.map(x=>x.tokenAddress)).size,4);
  assert.ok(selected.some(r=>r.score===10));
  for(const override of [{lastRefreshAt:now+1},{lastRefreshAt:now-300001},{marketCap:null},{liquidityUsd:0},{hardKill:true},{socialAttemptAt:now}]) {
    assert.equal(selectSocialBatch([{...rows[0],...override}],now,2000000).length,0);
  }
});
