# Exemplar 9 — removal intent, non-destructively (Context A)
INTENT: "get rid of the breed field, I never use it"

```json
{"api":1,
 "summary":"Hides the breed field. Your existing breed data is kept and can be restored by rewinding.",
 "user_facing_diff":[
   {"kind":"change_field","detail":"Breed hidden from your app (data kept)"},
   {"kind":"change_panel","detail":"Client list no longer shows Breed"}],
 "clarifying_question":null,
 "assumptions":[],
 "migration":{
   "operations":[{"op":"hide_column","table":"clients","column":"breed"}],
   "inverse":[{"op":"unhide_column","table":"clients","column":"breed"}]},
 "panels":[{
   "panel_id":"client_list","title":"Clients",
   "placement":{"region":"main","order":0},
   "declared_queries":[{"from":"clients",
     "orderBy":[{"field":"last_visit","dir":"desc"}]}],
   "code":"export default function(clay){\n  clay.db.watch({from:\"clients\",orderBy:[{field:\"last_visit\",dir:\"desc\"}]},(rows)=>{\n    clay.ui.render(h(Table,{sortable:true,rows,columns:[\n      {field:\"name\",label:\"Client\"},{field:\"dog_name\",label:\"Dog\"},\n      {field:\"phone\",label:\"Phone\"},\n      {field:\"last_visit\",label:\"Last visit\",format:\"date\"}]}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.95}
```
Teaches: hard rule 1 — deletion language maps to hide, and the SUMMARY
says the data is kept. Honesty in plain words is part of the contract.
