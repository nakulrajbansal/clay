# Exemplar 2 — enum field + badge (Context B)
INTENT: "add a priority to each project: low, medium, high, and make high stand out"

```json
{"api":1,
 "summary":"Adds a priority (low/medium/high) to projects; high shows as a red badge in the table.",
 "user_facing_diff":[
   {"kind":"add_status","detail":"Priority: low / medium / high on projects"},
   {"kind":"change_panel","detail":"Project table gains a Priority badge column"}],
 "clarifying_question":null,
 "assumptions":["New projects default to medium"],
 "migration":{
   "operations":[
     {"op":"add_column","table":"projects","column":{"name":"priority",
       "type":"enum","required":false,"values":["low","medium","high"]}},
     {"op":"backfill","table":"projects","column":"priority","value":"medium"}],
   "inverse":[{"op":"drop_column_if_added_by_this","table":"projects",
     "column":"priority"}]},
 "panels":[{
   "panel_id":"project_table","title":"Projects",
   "placement":{"region":"main","order":0},
   "declared_queries":[{"from":"projects"}],
   "code":"export default function(clay){\n  clay.db.watch({from:\"projects\"},(rows)=>{\n    clay.ui.render(h(Table,{sortable:true,rows,columns:[\n      {field:\"name\",label:\"Project\"},\n      {field:\"owner\",label:\"Owner\"},\n      {field:\"status\",label:\"Status\",badge:{field:\"status\",map:{green:\"green\",amber:\"amber\",red:\"red\"}}},\n      {field:\"priority\",label:\"Priority\",badge:{field:\"priority\",map:{high:\"red\",medium:\"amber\",low:\"gray\"}}},\n      {field:\"next_milestone\",label:\"Next milestone\",format:\"date\"}]}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.93}
```
Teaches: enum + backfill pairing; badge maps; sensible default recorded.
