import Link from 'next/link';
import { buildRecommendations } from '@/lib/recommendations';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Recommendations · MESA Archive' };

export default async function Recommendations() {
  const recos = await buildRecommendations();
  const areas = [...new Set(recos.map((r) => r.area))];
  return (
    <main className="stack">
      <div>
        <h1>Getting the most out of MESA</h1>
        <p className="muted">Worked out from your deadlines, MRS, attendance, calendar and notices each time you open this page. Red is this week, amber is soon or needs a decision, green is worth doing.</p>
      </div>
      <div className="row small">{areas.map((a) => <a key={a} href={`#${a}`} className="pill">{a}</a>)}</div>
      {areas.map((area) => (
        <section key={area} id={area} className="card">
          <h2>{area}</h2>
          <ul className="list">
            {recos.filter((r) => r.area === area).map((r, i) => (
              <li key={i} className={`reco ${r.priority}`}>
                <i />
                <div>
                  <strong>{r.href ? <Link href={r.href}>{r.title}</Link> : r.title}</strong>
                  <div className="small">{r.why}</div>
                  {r.action && <div className="small"><span className="muted">Do:</span> {r.action}</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
