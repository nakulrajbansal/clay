# Exemplar 13 — a gantt/timeline via the Timeline component (Context C)
INTENT: "show my books on a timeline from when I started to when I finished"

```json
{"api":1,
 "summary":"Adds a timeline of your books, each a bar from start to finish.",
 "user_facing_diff":[
   {"kind":"add_panel","detail":"Reading timeline from start to finish date"}],
 "clarifying_question":null,
 "assumptions":["A book with no finish date yet shows as a milestone at its start"],
 "migration":null,
 "panels":[{
   "panel_id":"book_timeline","title":"Reading timeline",
   "placement":{"region":"main","order":1},
   "declared_queries":[{"from":"books","orderBy":[{"field":"started","dir":"asc"}]}],
   "declared_writes":[],
   "code":"export default function(clay){\n  clay.db.watch({from:\"books\",orderBy:[{field:\"started\",dir:\"asc\"}]},(rows)=>{\n    clay.ui.render(rows.length===0\n      ? h(EmptyState,{label:\"No books yet\"})\n      : h(Timeline,{rows:rows.map((b)=>({label:b.title,start:b.started,end:b.finished,at:b.started,\n          tone:b.finished?\"green\":\"accent\",caption:b.author}))}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.9}
```
Teaches: the Timeline component is THE answer to "show as a gantt/timeline"
— never hand-draw with Scene. A row with start+end renders as a bar; the
"at" fallback makes still-reading books (no finish) show as a milestone.
migration:null because a timeline is a new VIEW of existing dates.
