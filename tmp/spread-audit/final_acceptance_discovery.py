import sys,math,statistics,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'angel-one'))
from app.services.spreads import api
from app.services.spreads.discovery import discover
u,a=api._discovery_inputs('fixtures','');universe=u.get_universe();actual=discover(universe['items'],a)
expected=[]
for item in universe['items']:
 h=a.get_history(item['instrument_key']);c=h.closes;v=h.volumes
 rv=statistics.stdev([math.log(y/x) for x,y in zip(c,c[1:])][-21:])*math.sqrt(252)
 shock=v[-1]/statistics.mean(v[-21:-1]);chain=a.get_atm_chain(item['instrument_key'])
 ivs=[]
 for pairs in [chain.puts,chain.calls]:
  valid=[(k,q) for k,q in pairs if q.bid is not None and q.ask is not None and q.bid>0 and q.ask>=q.bid and q.implied_volatility is not None and q.implied_volatility>0]
  ivs.extend(q.implied_volatility for k,q in sorted(valid,key=lambda x:(abs(x[0]-c[-1]),x[0]))[:3])
 iv=statistics.median(ivs);vrp=iv/rv
 expected.append(dict(ticker=item['symbol'],spot=round(c[-1],2),chg=round((c[-1]/c[-2]-1)*100,2),rv21=round(rv,4),iv14=round(iv,4),vrp14=round(vrp,2),shock=round(shock,2),edge=bool(vrp>1.2 and shock>1.5)))
def percentile(value,values):
 return (sum(x<value for x in values)+(sum(x==value for x in values)+1)/2)/len(values)
for row in expected:
 row['score_raw']=percentile(row['vrp14'],[r['vrp14'] for r in expected])+percentile(row['shock'],[r['shock'] for r in expected])
expected.sort(key=lambda r:(r['edge'],r['score_raw']),reverse=True)
for e,r in zip(expected,actual.items):
 for key,value in e.items():
  if key!='score_raw':assert r[key]==value,(key,r[key],value)
 assert r['score']==round(e['score_raw'],2)
(ROOT/'tmp/spread-audit/final-acceptance-discovery.json').write_text(json.dumps({'scope':'Independent fixture discovery arithmetic and percentile ranking','expected':expected,'actual':actual.items,'stats':actual.stats},indent=2))
print('PASS independent discovery arithmetic/ranking:',len(expected),'underlyings')
