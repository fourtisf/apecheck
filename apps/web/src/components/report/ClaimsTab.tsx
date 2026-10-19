import type { CheckReportDTO } from '@apecheck/core';

/** renderTab('claims'): each claim with its result pill, where it was found and the evidence; then the narrative areas. */
export function ClaimsTab({ report: r }: { report: CheckReportDTO }) {
  return (
    <>
      {r.claims.length ? (
        <ul className="cl">
          {r.claims.map((c, i) => (
            <li key={i}>
              <b>“{c.text}”</b>
              <span className={`pill ${c.signal}`}>{c.label}</span>
              <small>
                <span>{c.sourceLabel}.</span> {c.evidence}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty" style={{ marginBottom: 28 }}>
          <p>The agent found no concrete claims to test on the site or in the post.</p>
        </div>
      )}
      {r.areas ? (
        <>
          <h4 className="h4">Narrative score by area</h4>
          <div className="areas">
            {Object.entries(r.areas).map(([k, v]) => (
              <div className="area" key={k}>
                <span>{k}</span>
                <span className="bar">
                  <i style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />
                </span>
                <span>{v}/100</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
