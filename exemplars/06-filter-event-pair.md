# Exemplar 6 — FilterBar + cross-panel event (Context B, ADR-012 pattern)
INTENT: "let me filter the whole board by owner"

```json
{"api":1,
 "summary":"Adds an owner filter that narrows the project table.",
 "user_facing_diff":[
   {"kind":"add_panel","detail":"Owner filter bar above the table"},
   {"kind":"change_panel","detail":"Project table responds to the filter"}],
 "clarifying_question":null,
 "assumptions":["Filter clears with the All option"],
 "migration":null,
 "panels":[
  {"panel_id":"owner_filter","title":"Filter",
   "placement":{"region":"top","order":2},
   "declared_queries":[{"from":"projects","select":["owner"],
     "groupBy":["owner"],"aggregate":[{"fn":"count","field":"owner","as":"n"}]}],
   "code":"export default function(clay){\n  clay.db.watch({from:\"projects\",select:[\"owner\"],groupBy:[\"owner\"],aggregate:[{fn:\"count\",field:\"owner\",as:\"n\"}]},(rows)=>{\n    clay.ui.render(h(FilterBar,{\n      filters:[{field:\"owner\",kind:\"select\",\n        options:[{value:\"\",label:\"All owners\"},...rows.map(r=>({value:r.owner,label:`${r.owner} (${r.n})`}))]}],\n      onChange:(state)=>clay.events.emit(\"board_filter\",state)}));\n  });\n}"},
  {"panel_id":"project_table","title":"Projects",
   "placement":{"region":"main","order":0},
   "declared_queries":[
     {"from":"projects"},
     {"from":"projects","where":[{"field":"owner","op":"eq","value":{"$var":true}}]}],
   "code":"export default function(clay){\n  let unsub=null;\n  const show=(q)=>{if(unsub)unsub();unsub=clay.db.watch(q,(rows)=>{\n    clay.ui.render(h(Table,{sortable:true,rows,columns:[\n      {field:\"name\",label:\"Project\"},{field:\"owner\",label:\"Owner\"},\n      {field:\"status\",label:\"Status\",badge:{field:\"status\",map:{green:\"green\",amber:\"amber\",red:\"red\"}}},\n      {field:\"next_milestone\",label:\"Next milestone\",format:\"date\"}]}));});};\n  show({from:\"projects\"});\n  clay.events.on(\"board_filter\",(s)=>{\n    show(s.owner? {from:\"projects\",where:[{field:\"owner\",op:\"eq\",value:s.owner}]} : {from:\"projects\"});\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.88}
```
Teaches: kernel-routed events; the {"$var":true} placeholder satisfying V4
while values vary at runtime; watch re-subscription pattern.
