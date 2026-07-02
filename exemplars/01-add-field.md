# Exemplar 1 — simple add_column (Context A)
INTENT: "I want to record each dog's weight"

```json
{"api":1,
 "summary":"Adds a weight field to your clients, shown in the client list.",
 "user_facing_diff":[
   {"kind":"add_field","detail":"Weight (number) on clients"},
   {"kind":"change_panel","detail":"Client list gains a Weight column"}],
 "clarifying_question":null,
 "assumptions":["Weight in pounds; label says (lbs)"],
 "migration":{
   "operations":[{"op":"add_column","table":"clients",
     "column":{"name":"weight_lbs","type":"number","required":false}}],
   "inverse":[{"op":"drop_column_if_added_by_this","table":"clients",
     "column":"weight_lbs"}]},
 "panels":[{
   "panel_id":"client_list","title":"Clients",
   "placement":{"region":"main","order":0},
   "declared_queries":[{"from":"clients",
     "orderBy":[{"field":"last_visit","dir":"desc"}]}],
   "code":"export default function(clay){\n  const q={from:\"clients\",orderBy:[{field:\"last_visit\",dir:\"desc\"}]};\n  clay.db.watch(q,(rows)=>{\n    clay.ui.render(h(Table,{sortable:true,rows,columns:[\n      {field:\"name\",label:\"Client\"},\n      {field:\"dog_name\",label:\"Dog\"},\n      {field:\"breed\",label:\"Breed\"},\n      {field:\"weight_lbs\",label:\"Weight (lbs)\",format:\"number\"},\n      {field:\"last_visit\",label:\"Last visit\",format:\"date\"}]}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.95}
```
Teaches: minimal migration + whole-panel replacement of the affected panel
only; assumption recorded instead of a question.
