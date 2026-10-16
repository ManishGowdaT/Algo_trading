"""Build and verify the end-to-end Index VWAP ORB planning PDF."""
from pathlib import Path
import re
from html import escape
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, KeepTogether, Image
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/pdf/Index_VWAP_ORB_End_to_End_Implementation_Plan.pdf'
SOURCE = ROOT / 'NIFTY_VWAP_ORB_IMPLEMENTATION_PLAN.md'
NAVY = colors.HexColor('#142C48')
BLUE = colors.HexColor('#1559CF')
LIGHT = colors.HexColor('#EDF3FA')
STYLES = getSampleStyleSheet()
STYLES.add(ParagraphStyle(name='CoverTitleX', fontName='Helvetica-Bold', fontSize=29, leading=35, textColor=NAVY, spaceAfter=20))
STYLES.add(ParagraphStyle(name='SectionX', fontName='Helvetica-Bold', fontSize=18, leading=23, textColor=NAVY, spaceAfter=13, keepWithNext=True))
STYLES.add(ParagraphStyle(name='SubX', fontName='Helvetica-Bold', fontSize=12, leading=16, textColor=BLUE, spaceBefore=11, spaceAfter=7, keepWithNext=True))
STYLES.add(ParagraphStyle(name='BodyX', fontName='Helvetica', fontSize=9.5, leading=14, textColor=NAVY, spaceAfter=8))
STYLES.add(ParagraphStyle(name='CellX', fontName='Helvetica', fontSize=7.5, leading=10, textColor=NAVY))
STYLES.add(ParagraphStyle(name='SmallX', fontName='Helvetica', fontSize=8, leading=11, textColor=colors.HexColor('#53677E'), spaceAfter=8))

def clean(text):
    for a,b in {'\u2014':' - ','\u2013':'-','\u2011':'-','\u2019':"'",'\u201c':'"','\u201d':'"','\u2192':' -> '}.items():
        text=text.replace(a,b)
    return text

def rich(text):
    text=escape(clean(text))
    text=text.replace('&lt;br/&gt;', '<br/>')
    text=re.sub(r'\[([^\]]+)\]\((https?://[^)]+)\)', r'<link href="\2" color="#1559CF">\1</link>',text)
    text=re.sub(r'\*\*([^*]+)\*\*',r'<b>\1</b>',text)
    return text

def p(text,style='BodyX'):
    return Paragraph(rich(text),STYLES[style])

story=[]
story += [Spacer(1,55), p('IMPLEMENTATION BLUEPRINT','SmallX'), p('Index VWAP +<br/>Opening Range +<br/>1M Execution','CoverTitleX'), p('NIFTY  |  BANKNIFTY  |  SENSEX','SubX'), Spacer(1,18), p('Complete end-to-end phased delivery plan'), p('Prepared 16 October 2026 | Strategy ID: IndexVwapOrb'), Spacer(1,22)]
summary=Table([[p('SAME USER JOURNEY','SubX')],[p('Existing broker connection, account selection, option configuration, Start/Stop, monitoring and trade history. The new analyzer evaluates the selected index; existing execution services trade its CE/PE.')],[p('PLANNING STATUS','SubX')],[p('This document specifies proposed changes. No strategy was enabled and no trading implementation or live order validation has been performed. Unresolved rule choices are called out before implementation.')]],colWidths=[465])
summary.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),LIGHT),('BOX',(0,0),(-1,-1),0.7,colors.HexColor('#CFDCEC')),('LEFTPADDING',(0,0),(-1,-1),16),('RIGHTPADDING',(0,0),(-1,-1),16),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]))
story += [summary,Spacer(1,20),p('Readiness gates: valid VWAP input per index, locked retest/pivot rules, durable daily admission, and correct separation of index trigger levels from option premium risk.','SmallX'),PageBreak()]
story += [p('Document guide','SectionX'),p('The blueprint follows the existing repository workflow and the corrected multi-index scope. Phase gates are acceptance conditions, not claims of completed work.')]
for title,desc in [
('Scope and strategy rules','Supported indices, exchange routing, preserved account flow and exact entry/exit interpretation.'),
('Current architecture and decisions','Source-backed integration points, data feasibility and rule choices that must be settled.'),
('Phases 0-7','Rule lock, market data, analyzer, admission, execution risk, UI, replay and rollout.'),
('Engineering appendices','Proposed data/API contracts, failure behavior, acceptance matrix and delivery responsibilities.'),
('Evidence and release checklist','Original dashboard capture, chart limitations, readiness checklist and references.')]:
    story += [p(title,'SubX'),p(desc)]
story += [Spacer(1,12),p('Key operating assumption','SubX'),p('One selected underlying per strategy instance, matching existing strategy pages. Two daily entries are shared across underlying changes for this account/strategy. This is a proposed baseline to lock in Phase 0; simultaneous independent instances and per-index trade quotas require an explicit policy change.'),PageBreak()]

lines=SOURCE.read_text(encoding='utf-8-sig').splitlines()
idx=0
while idx<len(lines):
    line=lines[idx].strip();idx+=1
    if not line:continue
    if line.startswith('# '):
        story += [p('Scope and operating model','SectionX')];continue
    if line.startswith('Prepared '):continue
    if line.startswith('## '):
        if line.startswith('## 4.'):continue
        if line.startswith('## 6.'):
            story += [Spacer(1,12),p(line[3:],'SubX')];continue
        story += [PageBreak(),p(line[3:],'SectionX')];continue
    if line.startswith('### '):
        if line.startswith('### Phase '):
            story += [PageBreak(),p(line[4:],'SectionX')]
        else:story += [p(line[4:],'SubX')]
        continue
    if line.startswith('|'):
        rows=[line]
        while idx<len(lines) and lines[idx].strip().startswith('|'):
            rows.append(lines[idx].strip());idx+=1
        parsed=[]
        for row in rows:
            cells=[c.strip() for c in row.strip('|').split('|')]
            if all(re.fullmatch(r'[-: ]+',c) for c in cells):continue
            parsed.append([p(c,'CellX') for c in cells])
        widths=[100,155,222] if len(parsed[0])==3 and 'Layer' in rows[0] else [145,145,187]
        t=Table(parsed,colWidths=widths,repeatRows=1,hAlign='LEFT')
        t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),LIGHT),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F7F9FC')]),('VALIGN',(0,0),(-1,-1),'TOP'),('GRID',(0,0),(-1,-1),0.35,colors.HexColor('#D6DFEA')),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),5),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
        story += [t,Spacer(1,12)];continue
    if line.startswith('- '):line='- '+line[2:]
    if line.startswith('Exit gate:'):
        story += [p('Phase acceptance gate','SubX'),p(line[len('Exit gate:'):].strip())]
    else:story.append(p(line))

def section(title):story.extend([PageBreak(),p(title,'SectionX')])
def item(title,text):story.extend([p(title,'SubX'),p(text)])

section('Appendix A - Engineering contracts')
item('Configuration and settings', 'Proposed fields: strategyId, underlying, strikeMode, strikeDepth, quantity, premiumMin/premiumMax where supported, approved retestTolerancePoints and liveTradingConsent. Reuse automatic expiry policy unless the existing account flow exposes a selector. Validate quantity against resolved lot metadata on both save and start. Fixed rules are server-authoritative: riskReward=2, swingLength=2, stopBufferPoints=2, entry cutoff 11:30 IST and daily cap 2. The broker account comes from verified account context, never a trusted arbitrary request field.')
item('Analysis input', 'Use completed 1M/5M OHLCV, underlying identity, session date, asOf timestamp, volume-source descriptor, rule version and setup checkpoint. Each bar carries openTime, closeTime, completeness and source. Freshness and session completeness are explicit; the analyzer receives no credentials and performs no broker mutation.')
item('Analysis output', 'Use NONE/ENTRY with direction LONG/SHORT, setupId, signalId, signalClosedAt, referenceInstrument, entryReference, stopReference, targetReference, riskPoints and isExit=false. Diagnostics carry OR levels, VWAP, retest candle, pivot formation/confirmation timestamps and blocking reasons. Map this result through an adapter to the current runner interface; do not assume the existing option-centric result shape can carry it unchanged.')
item('Session persistence', 'Proposed StrategySession collection: userId, brokerAccountId, strategyId, istDate, entriesFilled, reservations, ruleVersion, setupByUnderlying, lastProcessedByStream and version. Unique scope index protects one daily record. Signal identity includes underlying, direction, setup identity and closed entry-bar timestamp. Use atomic conditional admission under the existing execution lease; verify transaction support before selecting a cross-document transaction implementation.')
item('Held-position snapshot', 'Persist underlying token/exchange, option contract token/exchange/symbol/expiry, actual filled quantity and premium average, index entry/stop/target, risk direction, rule version, execution mode and generic protection policy. Changes to saved settings must not rewrite an open position. Exit records retain trigger index price/time separately from actual option sell fills and realized P&L.')
item('Backward compatibility', 'Add fields and capabilities without reinterpreting old premium-based positions. Missing riskReferenceType on an existing position continues the documented legacy behavior. Restore a new index-reference position only from sufficient durable metadata; otherwise show reconciliation required rather than infer levels from current settings.')

section('Appendix B - UI and service integration')
item('Connection and launch sequence', 'Dashboard -> existing Connect Angel One modal if needed -> selected broker account -> Strategies -> Index VWAP ORB -> select NIFTY/BANKNIFTY/SENSEX -> familiar option settings -> validated Save -> existing live consent if applicable -> Start. Display data readiness before admitting entries. Broker reconnection uses the current provider and session generation rules, not a second login flow.')
item('Existing API family', 'Reuse GET /strategies/manifests, GET /strategies/IndexVwapOrb/status, POST /strategies/IndexVwapOrb/start, /stop and /exit after confirming route middleware. Reuse the existing settings API rather than introducing a separate persistence path. Add optional status diagnostics compatibly. Status reads, chart mounts and polling must not submit orders or enable the strategy.')
item('Status model', 'Report scan stage separately from execution exposure. Include selected underlying, connection health, data freshness, OR/VWAP readiness, setup stage, entry blockers, entries filled/reserved, contract resolution and held-position state. Preserve POSITION_PROTECTED/POSITION_UNPROTECTED, EXIT_PENDING and RECONCILIATION_REQUIRED semantics. A software spot trigger alone must not imply working broker-native protection.')
item('Chart behavior', 'Use regular selected-index candles for decisions and overlays. Keep the existing chart toolbar and user toggles. Display the opening window, frozen OR lines, session VWAP, retest/pivot knowledge markers and post-entry index SL/target. Option premium and fills remain in the position summary/history. UI rendering follows backend analysis diagnostics, avoiding a separate browser-side trading algorithm.')
item('Stop, exit and selection changes', 'Stop disables new entries and setup scanning while held exposure remains managed. Exit invokes the existing coordinated exit path and stays pending until reconciliation. Underlying/account changes must preserve original position monitoring and reject stale UI responses. Do not silently clear daily usage on refresh, reconnect, index change or strategy restart.')

section('Appendix C - Failure and recovery behavior')
for title,text in [
('Incomplete opening range / invalid volume','Block entry and state the missing bars or volume source problem. Backfill and re-evaluate only using information available as of the event; do not create invented history.'),
('Duplicate, delayed or out-of-order event','Deduplicate by stream and candle identity. Repair order and gaps before analysis. Admission checks the current cutoff as well as signal close time; late delivery cannot bypass the entry window.'),
('Entry timeout or partial fill','Retain reservation and durable intent until broker reconciliation. Never submit a second entry merely because acknowledgement is missing. First non-zero fill consumes one daily entry; additional fills do not add another count.'),
('Spot or option feed failure','Block new entries. Keep exposure visible, distinguish missing trigger data from missing execution quotes, and apply the approved generic outage policy. Do not claim a historical threshold fill after data returns.'),
('Concurrent target, stop, manual or EOD trigger','Route all through the same coordinated exit intent. Reconcile protection and remaining quantity before additional sells. A stop-order fill racing a manual sell must not produce an unintended short option position.'),
('Backend restart or session replacement','Restore leases, unresolved intents, daily reservations and held risk snapshots before admission. Recover subscriptions for both the index risk reference and held option. Reconstruction does not automatically enable new scanning.'),
('Database unavailable','Block new entry if durable admission cannot be recorded. Preserve uncertain broker outcomes for recovery and alert through existing mechanisms; do not infer completion from a failed persistence write.'),
('EOD exit incomplete','Persist exit pending, reconcile residual quantity and expose operational attention. A scheduled request or market-close event is not proof of square-off. Keep a documented manual broker recovery route.')]:item(title,text)

section('Appendix D - Acceptance and regression matrix')
for title,text in [
('Strategy semantics - all three indices','LONG and SHORT fixtures; exact opening-range interval; completed 5M breakout; later accepted retest; two-left/two-right confirmed pivot; later strict close break; VWAP side; finite risk; exact 2R; no unintended candle-colour filter.'),
('Time and data boundaries','IST date reset, machine timezone independence, 09:30 range lock, close-time convention, exact 11:30 boundary and delayed event, session holidays, late-start backfill, missing bars, zero volume and duplicate history/live overlap.'),
('Routing and option configuration','NIFTY/BANKNIFTY NSE spot to NFO options; SENSEX BSE spot to resolved BFO options; ATM/ITM/OTM depth, premium filters, expiry policy, lot-size validity, quantity, broker/account identity and stale contract rejection.'),
('Admission concurrency','Two accepted entry fills and third blocked; reservation races; confirmed unfilled rejection releases capacity; unknown submission does not; partial fill counted once; index switch, reconnect and restart do not reset the cap.'),
('Risk and recovery','Correct LONG/SHORT index exit inequalities; premium fills/P&L remain separate; restart preserves levels; Stop retains monitoring; concurrent triggers yield one coordinated sell; partial exit uses remaining quantity; EOD completion is reconciled.'),
('UI compatibility','Desktop/mobile control parity, saved settings restore, account switch isolation, no duplicate discovery card, meaningful readiness messages, daily counter, chart toggle behavior, and separate index trigger versus premium labels.'),
('Existing strategy regressions','Run relevant baseline strategy tests, account-isolation, execution gateway, position execution, feed isolation, startup recovery and frontend settings lifecycle suites. Compare existing signal/risk fixtures; no unintended behavior change is acceptable.'),
('Evidence pack','For each case record input fixture/session, rule version, evaluation time, expected result, actual result, diagnostic trace and linked test output. Include verified real chart annotations for each supported index once valid data exists; label replay and paper executions accurately.')]:item(title,text)

section('Appendix E - Delivery ownership and release')
item('Phase ownership', 'Phase 0: strategy/product owner plus market-data engineer. Phase 1: feed/backend owner. Phase 2: strategy/backend owner. Phase 3: persistence/execution owner. Phase 4: execution and operations owners. Phase 5: frontend owner with backend diagnostics support. Phase 6: QA plus strategy/execution owners. Phase 7: release/operations owner and account operator. These are responsibilities, not assignments to named people.')
item('Reviewable deliverables', 'Deliver phase changes as bounded reviews: (1) rule contract/data evidence, (2) compatible feed requirements and spot streams, (3) pure analyzer and fixtures, (4) settings/session admission, (5) generic risk and recovery, (6) familiar UI and overlays, (7) replay/paper evidence, (8) account rollout and runbook. Each review lists behavior, affected files, checks, migration and rollback implications.')
item('Dependencies and estimation', 'Phase 0 gates the data model and analyzer. Phase 1 enables Phase 2. Phases 3 and 4 must integrate before executable entries. UI structure can be prepared after rule lock, but full acceptance depends on real status/risk data. Replay requires all execution and UI contracts. Estimate effort after data feasibility and generic risk scope are known; no unsupported delivery dates are committed.')
item('Migration and rollout', 'Create additive fields/indexes, retain compatibility with existing positions, and register the new strategy idempotently. Gate account availability independently from registry discovery. Default stopped and live consent off. Roll out shadow evaluation, then paper, then operator-enabled live use after gates pass. Do not silently backfill consent or activate accounts.')
item('Rollback', 'Disable new IndexVwapOrb admission first. Continue monitoring and reconciliation for held positions using a compatible release. Avoid reverting to code unable to understand index-reference risk while exposure remains. Preserve session counters, intents, fills and snapshots; remove feature visibility only after operational continuity is confirmed.')
item('Operational checklist', 'Before session: broker/account health, feed freshness and volume validity, contract metadata, session date, daily reservations, existing exposure and global square-off schedule. During session: stage/blockers, delays, intents, partial fills and protection. After cutoff: no new admissions, held monitoring active. After square-off: verify zero remaining quantity or explicitly unresolved status, save outcomes and reconcile the daily entry ledger.')

section('Appendix F - Original UI evidence')
story += [p('The untouched screenshot below was captured from the running local dashboard. Angel One was disconnected and the selected NIFTY chart was empty. It confirms the existing layout, not a real strategy setup. The previous AI-generated storyboard has known scale inconsistencies and is deliberately excluded as a validation chart.'),Spacer(1,8)]
imgpath=ROOT/'output/nifty-vwap-orb/original-dashboard.jpg'
from PIL import Image as PILImage
with PILImage.open(imgpath) as im: iw,ih=im.size
height=490
story += [Image(str(imgpath),width=height*iw/ih,height=height),Spacer(1,8),p('Required follow-up evidence: valid completed-session candles and rule-derived overlays for NIFTY, BANKNIFTY and SENSEX.','SmallX')]

section('Final readiness checklist and references')
for text in [
'Rules locked: tolerance per index, retest timeframe, pivot timing/ties, invalidation, cutoff and daily-count policy.',
'Valid and documented VWAP input for each enabled index; no silent proxy or equal-weight substitute.',
'Closed 1M/5M data, correct exchange routing, full-session backfill and freshness checks verified.',
'Pure analyzer produces deterministic diagnostics without future-bar information.',
'Daily admission survives races, ambiguous submissions, index changes and process restarts.',
'Option contract metadata, margin/quote checks, actual fills and index-reference exits reconcile correctly.',
'Global EOD behavior and outage/manual recovery policy are operationally verified.',
'Same connection/settings/control flow works on desktop/mobile with correct account isolation.',
'Replay, paper and existing-strategy regression evidence is reviewed for all three indices.',
'Feature gate, stopped default, live consent, monitoring and rollback are ready for the target account.'
]:story.append(p('- '+text))
item('Source basis', 'Repository review and corrected implementation plan: NIFTY_VWAP_ORB_IMPLEMENTATION_PLAN.md. User-provided strategy contract: attached Pasted text.txt. Key source modules are listed in section 2. Proposed modules, collections and APIs in appendices are design proposals; their existence is not implied.')
item('External source', '[Angel One SmartAPI documentation](https://smartapi.angelone.in/docs), checked 16 October 2026. Historical records include timestamp/OHLC/volume; the documented NIFTY example uses zero volume. Actual broker samples must establish suitability for each enabled index.')
story += [p('Completion of this PDF is documentation delivery only. Phase gates, testing and live readiness remain implementation work.','SmallX')]

def footer(canvas,doc):
    w,h=A4
    canvas.setStrokeColor(colors.HexColor('#D6DFEA'));canvas.line(36,39,w-36,39)
    canvas.setFont('Helvetica',7.5);canvas.setFillColor(colors.HexColor('#53677E'))
    canvas.drawString(36,27,'INDEX VWAP ORB | NIFTY / BANKNIFTY / SENSEX | 16 OCT 2026')
    canvas.drawRightString(w-36,27,f'{doc.page}')
    if doc.page>1:
        canvas.setFont('Helvetica',7);canvas.drawString(36,h-25,'END-TO-END IMPLEMENTATION PLAN - PROPOSED DESIGN')

OUT.parent.mkdir(parents=True,exist_ok=True)
doc=SimpleDocTemplate(str(OUT),pagesize=A4,rightMargin=42,leftMargin=42,topMargin=45,bottomMargin=53,title='Index VWAP ORB - End-to-End Implementation Plan',author='OptionAlgo implementation planning')
doc.build(story,onFirstPage=footer,onLaterPages=footer)
reader=PdfReader(str(OUT));text='\n'.join(page.extract_text() or '' for page in reader.pages)
for token in ['NIFTY','BANKNIFTY','SENSEX']+[f'Phase {i}' for i in range(8)]+['Appendix A','Appendix F']:
    assert token in text,token
assert all((page.extract_text() or '').strip() for page in reader.pages)
print(f'PDF: {OUT}\nPages: {len(reader.pages)}\nText coverage: passed\nBytes: {OUT.stat().st_size}')
