# Exemplar 14 — workflow: a staged process with one-click advance (Context B)
INTENT: "turn this into a workflow: requests go submitted → in review → approved → paid"

```json
{"api":1,
 "summary":"Adds a workflow view: requests move through submitted, in review, approved, and paid with one click.",
 "user_facing_diff":[
   {"kind":"add_panel","detail":"Request workflow with advance buttons and progress"}],
 "clarifying_question":null,
 "assumptions":["Stage order is submitted, in_review, approved, paid"],
 "migration":null,
 "panels":[{
   "panel_id":"request_flow","title":"Request workflow",
   "placement":{"region":"main","order":0},
   "declared_queries":[{"from":"requests","orderBy":[{"field":"created_at","dir":"asc"}]}],
   "declared_writes":["requests"],
   "code":"export default function(clay){\n  const stages=[\n    {key:\"submitted\",label:\"Submitted\",tone:\"gray\"},\n    {key:\"in_review\",label:\"In review\",tone:\"amber\"},\n    {key:\"approved\",label:\"Approved\",tone:\"green\"},\n    {key:\"paid\",label:\"Paid\",tone:\"accent\"}];\n  const q={from:\"requests\",orderBy:[{field:\"created_at\",dir:\"asc\"}]};\n  clay.db.watch(q,(rows)=>{\n    const items=rows.map((r)=>({id:r.id,title:r.title,\n      subtitle:r.requester,stage:r.stage,\n      badge:clay.compute.formatCurrency(r.amount||0),badgeTone:\"gray\"}));\n    clay.ui.render(h(Flow,{stages,items,onAdvance:async(item,toKey)=>{\n      await clay.db.update(\"requests\",item.id,{stage:toKey});\n    }}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.93}
```
Teaches: Flow for any "workflow / process / approval chain / stages"
intent. stages are ORDERED and mirror the stage enum's values; items carry
id + current stage; onAdvance updates the record's stage enum (so the
table is in declared_writes) and the watch re-renders — advancing is one
click, reversible via the back button and the app timeline. migration is
null when the stage enum already exists; when it doesn't, add the enum
column (with the stage values in process order) in the same plan.
