from pathlib import Path
import pymupdf as fitz
import numpy as np
src=Path(r'C:\Users\Manish gowda\Downloads\Manishresume12.pdf')
out=Path('output/pdf/Manish_Gowda_Resume_Updated.pdf')
doc=fitz.open(src)
p=doc[0]
region=fitz.Rect(31,407,595,487)
before=p.get_pixmap(matrix=fitz.Matrix(2,2),alpha=False)
original_spans=[(s['bbox'],s['text']) for b in p.get_text('dict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans'] if not fitz.Rect(s['bbox']).intersects(region)]
p.add_redact_annot(region,fill=(1,1,1))
p.apply_redactions(images=0,graphics=0)
fonts={}
for name,file in [('ResumeRegular','calibri.ttf'),('ResumeBold','calibrib.ttf'),('ResumeItalic','calibrii.ttf')]:
    path=Path('C:/Windows/Fonts')/file
    p.insert_font(fontname=name,fontfile=str(path))
    fonts[name]=fitz.Font(fontfile=str(path))
def text(x,y,t,font='ResumeRegular',size=9.96):
    assert x+fonts[font].text_length(t,fontsize=size)<=595, t
    p.insert_text((x,y),t,fontname=font,fontsize=size,color=(0,0,0))
text(32.52,419,'OptionAlgo | Algorithmic Trading & Options Research Platform','ResumeBold')
date='In development'
text(590-fonts['ResumeItalic'].text_length(date,fontsize=9.96),419,date,'ResumeItalic')
text(32.52,432,'React, TypeScript, Node.js, Express, Python, FastAPI, MongoDB, Angel One SmartAPI','ResumeItalic')
lines=[
'Built a multi-user trading platform integrating Angel One market data, interactive charts and strategy monitoring;',
'implemented account-isolated sessions, encrypted credential storage and validated REST APIs.',
'Developed Bull Put/Bear Call spread research with multi-stock scans, decimal-based payoff and volatility analytics;',
'added ranked results, cancellable background jobs, failure isolation and automated cross-service regression tests.'
]
for y,t in zip([445.2,457.44,470.64,482.88],lines): text(49.44,y,t)
for y in [442.5,467.94]: p.draw_circle((39.8,y),1.15,color=(0,0,0),fill=(0,0,0))
doc.save(out,garbage=4,deflate=True)
doc.close()
updated=fitz.open(out); q=updated[0]
assert len(updated)==1
new_spans=[(s['bbox'],s['text']) for b in q.get_text('dict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans'] if not fitz.Rect(s['bbox']).intersects(region)]
assert original_spans==new_spans,'Text outside replacement changed'
assert 'Car Rental' not in q.get_text()
after=q.get_pixmap(matrix=fitz.Matrix(2,2),alpha=False)
a=np.frombuffer(before.samples,dtype=np.uint8).reshape(before.height,before.width,3)
b=np.frombuffer(after.samples,dtype=np.uint8).reshape(after.height,after.width,3)
mask=np.any(a!=b,axis=2)
mask[int(region.y0*2):int(region.y1*2)+1,int(region.x0*2):int(region.x1*2)+1]=False
assert not mask.any(),'Pixels outside replacement changed'
after.save('tmp/pdfs/resume_updated.png')
print('PASS: one page; all text and rendered pixels outside the replacement region unchanged.')
print(out.resolve())
