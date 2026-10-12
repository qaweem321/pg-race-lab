import type { Database, Version } from "../engine/database";
import type { Session } from "../engine/lab";

type Props = { db: Database; tables: string[]; sessions: Session[] };

// Every row version, so you can see uncommitted changes, deleted rows and locks.
export function TablesView({ db, tables, sessions }: Props) {
  const versions = db.allVersions();
  const nameOf = (txId: number | null) =>
    txId === null || txId === 0 ? null : (sessions.find((s) => s.tx.id === txId)?.name ?? null);
  const indexOf = (txId: number | null) => sessions.findIndex((s) => s.tx.id === txId);

  const describe = (v: Version) => {
    const tags: { text: string; tx: number }[] = [];
    const creator = db.tx(v.xmin);
    const remover = v.xmax === null ? null : db.tx(v.xmax);
    if (creator.status === "active") tags.push({ text: `new, not committed (${creator.name})`, tx: indexOf(creator.id) });
    if (remover?.status === "active") {
      tags.push({ text: `${v.next ? "replaced" : "deleted"}, not committed (${remover.name})`, tx: indexOf(remover.id) });
    }
    if (v.lockedBy !== null && nameOf(v.lockedBy)) tags.push({ text: `🔒 locked by ${nameOf(v.lockedBy)}`, tx: indexOf(v.lockedBy) });
    const dead = remover?.status === "committed";
    return { tags, dead };
  };

  return (
    <section className="panel tables" aria-label="Tables">
      <h2>Tables</h2>
      {tables.map((table) => {
        const rows = versions.filter((v) => v.table === table);
        const columns = [...new Set(rows.flatMap((v) => Object.keys(v.values)))];
        return (
          <div key={table} className="table-block">
            <h3>{table}</h3>
            {rows.length === 0 ? (
              <p className="muted small">(no rows)</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                      <th>state</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((v) => {
                      const { tags, dead } = describe(v);
                      return (
                        <tr key={v.vid} className={dead ? "dead" : ""}>
                          {columns.map((c) => (
                            <td key={c}>{String(v.values[c] ?? "")}</td>
                          ))}
                          <td className="state">
                            {dead ? (
                              <span className="muted">{v.next ? "old version" : "deleted"}</span>
                            ) : tags.length === 0 ? (
                              <span className="muted">committed</span>
                            ) : (
                              tags.map((t) => (
                                <span key={t.text} className={`tag tag-${t.tx}`}>
                                  {t.text}
                                </span>
                              ))
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
