# Exemplar 14 — workflow: staged process, one-click advance, audit trail (Context B)
INTENT: "turn this into a workflow: requests go submitted → in review → approved → paid"

```json
{"api":1,
 "summary":"Adds a workflow: requests move through submitted, in review, approved, and paid, and every move is recorded in an activity log.",
 "user_facing_diff":[
   {"kind":"add_field","detail":"Activity log table recording each move (request, from, to, date)"},
   {"kind":"add_panel","detail":"Request workflow with confirm-to-advance buttons and progress"},
   {"kind":"add_panel","detail":"Activity panel listing recent moves, newest first"}],
 "clarifying_question":null,
 "assumptions":["Stage order is submitted, in_review, approved, paid"],
 "migration":{
   "operations":[
     {"op":"create_table","table":"request_activity","columns":[
       {"name":"request","type":"text","required":true},
       {"name":"from_stage","type":"text","required":false},
       {"name":"to_stage","type":"text","required":false},
       {"name":"moved_on","type":"date","required":false}]}],
   "inverse":[
     {"op":"drop_table_if_created_by_this","table":"request_activity"}]},
 "panels":[{
   "panel_id":"request_flow","title":"Request workflow",
   "placement":{"region":"main","order":0},
   "declared_queries":[{"from":"requests","orderBy":[{"field":"created_at","dir":"asc"}]}],
   "declared_writes":["requests","request_activity"],
   "code":"export default function(clay){\n  const stages=[\n    {key:\"submitted\",label:\"Submitted\",tone:\"gray\"},\n    {key:\"in_review\",label:\"In review\",tone:\"amber\"},\n    {key:\"approved\",label:\"Approved\",tone:\"green\"},\n    {key:\"paid\",label:\"Paid\",tone:\"accent\"}];\n  const label=(k)=>{const s=stages.find((x)=>x.key===k);return s?s.label:k;};\n  const q={from:\"requests\",orderBy:[{field:\"created_at\",dir:\"asc\"}]};\n  clay.db.watch(q,(rows)=>{\n    const items=rows.map((r)=>({id:r.id,title:r.title,\n      subtitle:r.requester,stage:r.stage,\n      badge:clay.compute.formatCurrency(r.amount||0),badgeTone:\"gray\"}));\n    clay.ui.render(h(Flow,{stages,items,onAdvance:async(item,toKey)=>{\n      await clay.db.update(\"requests\",item.id,{stage:toKey});\n      await clay.db.insert(\"request_activity\",{request:item.title,\n        from_stage:item.stage,to_stage:toKey,\n        moved_on:clay.compute.now().slice(0,10)});\n      clay.ui.toast(item.title+\" moved to \"+label(toKey),\"success\");\n    }}));\n  });\n}"},
  {
   "panel_id":"request_activity_log","title":"Activity",
   "placement":{"region":"main","order":1},
   "declared_queries":[{"from":"request_activity","orderBy":[{"field":"created_at","dir":"desc"}],"limit":12}],
   "code":"export default function(clay){\n  const q={from:\"request_activity\",orderBy:[{field:\"created_at\",dir:\"desc\"}],limit:12};\n  clay.db.watch(q,(rows)=>{\n    clay.ui.render(rows.length===0\n      ? h(EmptyState,{label:\"No moves yet\"})\n      : h(Stack,{},rows.map((r)=>h(Box,{direction:\"row\",gap:\"sm\",align:\"center\"},\n          h(Text,{value:r.request,weight:\"bold\",size:\"sm\"}),\n          h(Badge,{label:r.from_stage+\" \\u2192 \"+r.to_stage,tone:\"accent\"}),\n          h(Text,{value:r.moved_on||\"\",size:\"xs\",muted:true})))));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.93}
```
Teaches: Flow for any "workflow / process / approval chain / stages"
intent — WITH its audit trail. stages are ORDERED and mirror the stage
enum; onAdvance updates the record's stage, INSERTS a transition row into
the activity table (both tables in declared_writes), and toasts the move;
a second panel lists recent transitions. The Flow component's advance
buttons are two-step (arm, then confirm) — do not stack a confirm dialog
on top. The activity table is created here (with its inverse); when the
app already has one, reuse it and set migration null.
