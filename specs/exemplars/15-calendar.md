# Exemplar 15 — calendar: a month view of existing dated data (Context B)
INTENT: "show my shifts on a calendar"

```json
{"api":1,
 "summary":"Adds a calendar view of your shifts by date.",
 "user_facing_diff":[
   {"kind":"add_panel","detail":"Shift calendar, one chip per shift on its day"}],
 "clarifying_question":null,
 "assumptions":["Chip color follows the shift status"],
 "migration":null,
 "panels":[{
   "panel_id":"shift_calendar","title":"Calendar",
   "placement":{"region":"main","order":1},
   "declared_queries":[{"from":"shifts","orderBy":[{"field":"date","dir":"asc"}]}],
   "code":"export default function(clay){\n  const tones={scheduled:\"gray\",confirmed:\"accent\",completed:\"green\"};\n  clay.db.watch({from:\"shifts\",orderBy:[{field:\"date\",dir:\"asc\"}]},(rows)=>{\n    clay.ui.render(rows.length===0\n      ? h(EmptyState,{label:\"No shifts yet\"})\n      : h(Calendar,{items:rows.map((r)=>({date:r.date,\n          label:(r.employee||\"\")+(r.start_time?\" \"+r.start_time:\"\"),\n          tone:tones[r.status]||\"gray\"}))}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.95}
```
Teaches: Calendar for any "calendar / month view / schedule by day"
intent — a NEW VIEW of existing dated data (migration null). Each row
maps to {date, label, tone}; the component owns the grid and the month
navigation. Never hand-compose a month grid from Boxes.
