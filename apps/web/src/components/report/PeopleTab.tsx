import type { CheckReportDTO } from '@apecheck/core';
import { Dot, Facts, Unknown } from './util';

/** renderTab('people'): the X account, followers, team, GitHub and docs, each with what the agent saw. */
export function PeopleTab({ report: r }: { report: CheckReportDTO }) {
  const p = r.people;
  const handle = p.handle ?? r.handle;
  // nothing known about the account (X unavailable): say so rather than leave the line bare
  const acctNote =
    [p.acct.age ? `${p.acct.age} old` : null, p.acct.renamed].filter(Boolean).join(', ') ||
    (p.acct.createdAt == null && p.acct.followers == null ? "Couldn't be read during this check" : '');
  return (
    <Facts
      rows={[
        [
          'X account',
          handle ? (
            <>
              <Dot s={p.acct.signal} />@{handle}
              {acctNote ? <small>{acctNote}</small> : null}
            </>
          ) : (
            <Unknown />
          ),
          'X',
        ],
        [
          'Followers',
          p.acct.followersText ? (
            <>
              {p.acct.followersText}
              {p.acct.quality ? <small>{p.acct.quality}</small> : null}
            </>
          ) : (
            <Unknown />
          ),
          'X',
        ],
        [
          'Team',
          p.team.text ? (
            <>
              <Dot s={p.team.signal} />
              {p.team.text}
            </>
          ) : (
            <Unknown />
          ),
          '',
        ],
        [
          'GitHub',
          p.git.text ? (
            <>
              <Dot s={p.git.signal} />
              {p.git.text}
            </>
          ) : (
            <Unknown />
          ),
          'GitHub',
        ],
        [
          'Docs',
          p.docs.text ? (
            <>
              <Dot s={p.docs.signal} />
              {p.docs.text}
            </>
          ) : (
            <Unknown />
          ),
          'Site',
        ],
      ]}
    />
  );
}
