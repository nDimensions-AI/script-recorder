import type { ScriptDocument } from "./types";

const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Merge only changes that do not overlap a user edit. Conflicts retain current. */
export function mergeThreeWay(
  base: ScriptDocument,
  current: ScriptDocument,
  proposal: ScriptDocument,
) {
  const conflicts: string[] = [];
  function merge(a: any, b: any, c: any, at: string): any {
    if (equal(b, c)) return structuredClone(b);
    if (equal(a, b)) return structuredClone(c);
    if (equal(a, c)) return structuredClone(b);
    if (
      [a, b, c].every((v) => v && typeof v === "object" && !Array.isArray(v))
    ) {
      const result: any = {};
      for (const key of new Set([
        ...Object.keys(a),
        ...Object.keys(b),
        ...Object.keys(c),
      ]))
        result[key] = merge(a[key], b[key], c[key], at + "." + key);
      return result;
    }
    if (
      ["sections", "blocks", "presenters"].some((key) =>
        at.endsWith("." + key),
      ) &&
      [a, b, c].every(Array.isArray)
    ) {
      const byId = (rows: any[]) => new Map(rows.map((v) => [v.id, v])),
        aa = byId(a),
        bb = byId(b),
        cc = byId(c),
        result = new Map();
      for (const key of new Set([...aa.keys(), ...bb.keys(), ...cc.keys()])) {
        const value = merge(
          aa.get(key),
          bb.get(key),
          cc.get(key),
          at + "[" + key + "]",
        );
        if (value !== undefined) result.set(key, value);
      }
      const ids = (rows: any[]) => rows.map((v) => v.id),
        aOrder = ids(a),
        bOrder = ids(b),
        cOrder = ids(c);
      let order = bOrder;
      if (equal(aOrder, bOrder)) order = cOrder;
      else if (!equal(aOrder, cOrder) && !equal(bOrder, cOrder))
        conflicts.push(at + ".order");
      return [...new Set([...order, ...result.keys()])]
        .filter((key) => result.has(key))
        .map((key) => result.get(key));
    }
    conflicts.push(at);
    return structuredClone(b);
  }
  const document = merge(base, current, proposal, "script") as ScriptDocument;
  const prior = new Map(
    current.sections.flatMap((s) => s.blocks.map((b) => [b.id, b] as const)),
  );
  for (const section of document.sections)
    for (const block of section.blocks) {
      const old = prior.get(block.id);
      if (
        old &&
        (!equal(old.refs, block.refs) ||
          old.text !== block.text ||
          !equal(old.imageDerivativeIds, block.imageDerivativeIds))
      )
        block.requiresTechnicalVerification = true;
    }
  return { document, conflicts };
}
