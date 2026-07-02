# Exemplar 3 — computed column + new alert panel (Context A, date math)
INTENT: "warn me when a dog's rabies vaccine is due within 30 days"

```json
{"api":1,
 "summary":"Adds a rabies vaccine due date to clients and a warning strip listing dogs due within 30 days.",
 "user_facing_diff":[
   {"kind":"add_field","detail":"Rabies vaccine due (date) on clients"},
   {"kind":"add_panel","detail":"Vaccines due soon strip, pinned to top"}],
 "clarifying_question":null,
 "assumptions":["You'll enter due dates per client; existing clients start blank"],
 "migration":{
   "operations":[{"op":"add_column","table":"clients",
     "column":{"name":"rabies_due","type":"date","required":false}}],
   "inverse":[{"op":"drop_column_if_added_by_this","table":"clients",
     "column":"rabies_due"}]},
 "panels":[{
   "panel_id":"vaccine_alerts","title":"Vaccines due soon",
   "placement":{"region":"top","order":1},
   "declared_queries":[{"from":"clients",
     "where":[{"field":"rabies_due","op":"within_days","value":30}],
     "orderBy":[{"field":"rabies_due","dir":"asc"}]}],
   "code":"export default function(clay){\n  const q={from:\"clients\",where:[{field:\"rabies_due\",op:\"within_days\",value:30}],orderBy:[{field:\"rabies_due\",dir:\"asc\"}]};\n  clay.db.watch(q,(rows)=>{\n    if(rows.length===0){clay.ui.render(h(EmptyState,{label:\"No vaccines due in the next 30 days\"}));return;}\n    clay.ui.render(h(Stack,{},\n      h(Badge,{tone:\"warning\",label:`${rows.length} vaccine${rows.length>1?\"s\":\"\"} due soon`}),\n      h(Table,{rows,columns:[\n        {field:\"dog_name\",label:\"Dog\"},\n        {field:\"name\",label:\"Owner\"},\n        {field:\"rabies_due\",label:\"Due\",format:\"date\"}]})));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.9}
```
Teaches: within_days keeps date math out of code; empty-state handling;
top-region alert pattern.
