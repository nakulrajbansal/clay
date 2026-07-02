# Exemplar 3 — computed column + alert strip (Context B; rewritten per G19)
INTENT: "give each project a health score: start at 100, minus 10 per slipped milestone, minus 5 per open risk. flag anything under 60"

```json
{"api":1,
 "summary":"Adds a health score to each project (100 minus slips and risks) and a strip flagging projects under 60.",
 "user_facing_diff":[
   {"kind":"add_computed","detail":"Health score on projects, from slipped milestones and open risks"},
   {"kind":"change_panel","detail":"Project table gains a Health column"},
   {"kind":"add_panel","detail":"Needs attention strip for projects under 60"}],
 "clarifying_question":null,
 "assumptions":["Scores may go below zero for badly slipped projects"],
 "migration":{
   "operations":[{"op":"create_computed","table":"projects","column":"health_score",
     "expr":"100 - 10 * slipped_milestones - 5 * open_risks"}],
   "inverse":[{"op":"drop_column_if_added_by_this","table":"projects",
     "column":"health_score"}]},
 "panels":[
  {"panel_id":"health_alerts","title":"Needs attention",
   "placement":{"region":"top","order":1},
   "declared_queries":[{"from":"projects",
     "where":[{"field":"health_score","op":"lt","value":60}],
     "orderBy":[{"field":"health_score","dir":"asc"}]}],
   "code":"export default function(clay){\n  const q={from:\"projects\",where:[{field:\"health_score\",op:\"lt\",value:60}],orderBy:[{field:\"health_score\",dir:\"asc\"}]};\n  clay.db.watch(q,(rows)=>{\n    clay.ui.render(rows.length===0\n      ? h(EmptyState,{label:\"All projects healthy\"})\n      : h(Stack,{},\n          h(Badge,{tone:\"warning\",label:`Needs attention: ${rows.length}`}),\n          h(Table,{rows,columns:[\n            {field:\"name\",label:\"Project\"},\n            {field:\"owner\",label:\"Owner\"},\n            {field:\"health_score\",label:\"Health\",badge:{field:\"health_score\",map:{\"<60\":\"red\",\"<80\":\"amber\",\">=80\":\"green\"}}}]})));\n  });\n}"},
  {"panel_id":"project_table","title":"Projects",
   "placement":{"region":"main","order":0},
   "declared_queries":[{"from":"projects"}],
   "code":"export default function(clay){\n  clay.db.watch({from:\"projects\"},(rows)=>{\n    clay.ui.render(h(Table,{sortable:true,rows,columns:[\n      {field:\"name\",label:\"Project\"},\n      {field:\"owner\",label:\"Owner\"},\n      {field:\"status\",label:\"Status\",badge:{field:\"status\",map:{green:\"green\",amber:\"amber\",red:\"red\"}}},\n      {field:\"health_score\",label:\"Health\",badge:{field:\"health_score\",map:{\"<60\":\"red\",\"<80\":\"amber\",\">=80\":\"green\"}}},\n      {field:\"next_milestone\",label:\"Next milestone\",format:\"date\"}]}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.9}
```
Teaches: create_computed keeps the math in the registry (editable without
touching code, no physical column per doc 04 §2); computed columns are
queryable like real ones; the canonical strip pattern (this is doc 03 §7's
worked example, which queries the column this plan creates); threshold
badge maps on number fields (G25).
