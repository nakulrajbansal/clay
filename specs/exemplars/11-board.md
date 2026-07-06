# Exemplar 11 — kanban board, a new view of existing data (Context B)
INTENT: "show the projects as a board grouped by status"

```json
{"api":1,
 "summary":"Adds a board view of your projects, grouped by status.",
 "user_facing_diff":[
   {"kind":"add_panel","detail":"Projects board grouped by status"}],
 "clarifying_question":null,
 "assumptions":["Columns follow the status values: green, amber, red"],
 "migration":null,
 "panels":[{
   "panel_id":"project_board","title":"Board",
   "placement":{"region":"main","order":1},
   "declared_queries":[{"from":"projects"}],
   "declared_writes":[],
   "code":"export default function(clay){\n  const cols=[\"green\",\"amber\",\"red\"];\n  clay.db.watch({from:\"projects\"},(rows)=>{\n    const groups=cols.map((s)=>({key:s,label:s,tone:s,\n      cards:rows.filter((r)=>r.status===s).map((r)=>({title:r.name,subtitle:r.owner}))}));\n    clay.ui.render(h(Board,{groups}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.92}
```
Teaches: Board for a status kanban; migration:null because this is a NEW
VIEW of data that already exists (a new panel, no schema change); the
panel shapes rows into groups and Board renders the columns; tone taken
from the status token.
