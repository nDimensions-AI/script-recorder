import type { ScriptDocument } from "./types";
export function timing(doc: ScriptDocument) {
  const presenters: Record<string, number> = {},
    sections: Record<string, number> = {};
  let total = 0;
  for (const section of doc.sections) {
    const rate =
        doc.presenters.find((p) => p.id === section.presenterId)
          ?.wordsPerMinute ?? 130,
      groups = new Map<string, { serial: number; overlap: number }>();
    for (const b of section.blocks) {
      const duration =
          b.durationSeconds ??
          (["say", "handoff"].includes(b.kind)
            ? (b.text.trim().split(/\s+/).filter(Boolean).length / rate) * 60
            : 0),
        g = groups.get(b.timingGroup) ?? { serial: 0, overlap: 0 };
      if (b.timingMode === "overlap") g.overlap = Math.max(g.overlap, duration);
      else g.serial += duration;
      groups.set(b.timingGroup, g);
    }
    const seconds = [...groups.values()].reduce(
      (n, g) => n + g.serial + g.overlap,
      0,
    );
    sections[section.id] = seconds;
    total += seconds;
    const key = section.presenterId ?? "unassigned";
    presenters[key] = (presenters[key] ?? 0) + seconds;
  }
  return { total: Math.round(total), sections, presenters };
}
