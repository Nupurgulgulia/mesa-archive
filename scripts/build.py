import json,re,glob,datetime
P='parts/'
courses=[json.load(open(P+'c0_preterm.json'))]+json.load(open(P+'c1_term1a.json'))+json.load(open(P+'c2_term1b.json'))+json.load(open(P+'c3_term2.json'))
def split_file(s):
    a=s.split('|'); return {"name":a[0],"type":a[1] if len(a)>1 else "","size":a[2] if len(a)>2 else ""}
for c in courses:
    for f in c.get('folders',[]):
        f['files']=[split_file(x) for x in f.get('files',[])]
    c['recordings']=[{"title":r[0],"date":r[1],"youtube_id":r[2],"url":"https://www.youtube.com/watch?v="+r[2]} for r in c.pop('recs',[])]
    c['id']=c['id']
terms={"Pre-Term":{"range":"before 10 Aug 2026"},"Term 1":{"range":"10 Aug - 18 Oct 2026","exams":"Mid-terms 19 Sep; end-terms 16 Oct; term break 17-18 Oct"},"Term 2":{"range":"19 Oct - 23 Dec 2026","exams":"Ops Week 26-30 Oct; Diwali 9-11 Nov; mid-term 23 Nov; end-term 22-23 Dec"}}
def term_of(d):
    return "Term 1" if d<datetime.date(2026,10,19) else "Term 2"
def kind(t):
    tl=t.lower()
    if re.search(r'end term exam|mid term exam|mid term exams|final exam|viva|end-term|exam prep|end prep|baseline assessment',tl): return 'exam'
    if re.search(r'holiday|vacation|term break',tl): return 'holiday'
    if re.search(r'building time|study block|office hours|doubt clearing|working session|flea prep',tl): return 'self-work'
    if re.search(r'startup leader|start-up leader|what is|panel|life @ mesa|life@mesa|byoB|hackathon|demo day|orientation|awards|spotlight|primer|mrs by|cracking|crack case|garba|talent|mixer',tl): return 'event'
    return 'class'
ev=[]
for fn in ['cal_a.txt','cal_b.txt','cal_c.txt']:
    for line in open(P+fn):
        line=line.strip()
        if not line: continue
        d,tm,title=line.split(' ',2)
        dt=datetime.date.fromisoformat(d); s,e=tm.split('-')
        ev.append({"date":d,"start":s,"end":e,"title":title,"term":term_of(dt),"kind":kind(title),"status":"past" if dt<datetime.date(2026,10,20) else ("today" if dt==datetime.date(2026,10,20) else "upcoming")})
asg=[]
for line in open(P+'assignments.txt'):
    a=line.rstrip('\n').split('|')
    if a and a[0]=='' and len(a)>1 and a[1]=='': a=a[1:]
    if len(a)<5: continue
    asg.append({"due":a[0] or None,"title":a[1],"type":a[2],"course":a[3],"status":a[4],"marks":a[5] if len(a)>5 and a[5] else None})
notes=[]
for line in open(P+'notifications.txt'):
    a=line.rstrip('\n').split('|')
    if len(a)>=4: notes.append({"when":a[0],"category":a[1],"title":a[2],"text":a[3]})
attendance={"overall":"94/119 (79%)","note":"Home page showed 93/119 (78.2%); Progress page 94/119 after a leave ticket update","subjects":[
["AI and its Application","15/22","68.2%"],["Business Frameworks with Pranjal Bangani","6/8","75%"],["Business Reader with Suprad","6/8","75%"],["Career Readiness","2/2","100%"],["Crafting Marketing Strategies","8/10","80%"],["Data Driven Decision Making","11/13","84.6%"],["Entrepreneurship 101","8/10","80%"],["Fundamentals of Finance","13/13","100%"],["Power of Communication","14/17","82.4%"],["The Art of Selling","8/13","61.5%"],["Business Metrics and Mindset (Term 2)","2/2","100%"],["Data 102 (Term 2)","1/1","100%"]]}
mrs={"score":62.9,"out_of":100,"sittings":["MRS 1: Baseline Submission (Where you start) - 62.9","MRS 2: Data, AI and communication - not yet scheduled","MRS 3 - not yet scheduled"],"eligibility":"Weekly 'Tell Me About Yourself' session on MRS Practice Lab must be completed to stay eligible; current assignment: Resume Stress Test, due 25 Oct 23:59"}
out={"student":"Nupur Gulgulia","program":"PGP Cohort IV, Batch 2027 (Mesa School of Business)","lms":"Nexus (students.mesaschool.co.in)","captured":"2026-10-20","grades":"No grades published on Nexus yet","terms":terms,"courses":courses,"calendar":ev,"assignments":asg,"notifications":notes,"attendance":attendance,"mrs":mrs}
json.dump(out,open('mesa_data.json','w'),ensure_ascii=False,separators=(',',':'))
from collections import Counter
print(len(courses),'courses',len(ev),'events',len(asg),'assignments',len(notes),'notes')
print(Counter((e['term'],e['kind']) for e in ev))
print(sum(len(c['recordings']) for c in courses),'recordings', sum(len(f['files']) for c in courses for f in c.get('folders',[])),'files')
print(Counter(a['status'] for a in asg))
