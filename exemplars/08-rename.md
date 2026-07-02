# Exemplar 8 — rename with untouched-panel integrity (Context B, gap G16)
INTENT: "rename owner to lead everywhere"

```json
{"api":1,
 "summary":"Renames the owner field to lead across your app.",
 "user_facing_diff":[
   {"kind":"change_field","detail":"Owner is now called Lead"},
   {"kind":"change_panel","detail":"Project table shows Lead"}],
 "clarifying_question":null,
 "assumptions":[],
 "migration":{
   "operations":[{"op":"rename_column","table":"projects","from":"owner","to":"lead"}],
   "inverse":[{"op":"rename_column","table":"projects","from":"lead","to":"owner"}]},
 "panels":[{
   "panel_id":"project_table","title":"Projects",
   "placement":{"region":"main","order":0},
   "declared_queries":[{"from":"projects"}],
   "code":"export default function(clay){\n  clay.db.watch({from:\"projects\"},(rows)=>{\n    clay.ui.render(h(Table,{sortable:true,rows,columns:[\n      {field:\"name\",label:\"Project\"},{field:\"lead\",label:\"Lead\"},\n      {field:\"status\",label:\"Status\",badge:{field:\"status\",map:{green:\"green\",amber:\"amber\",red:\"red\"}}},\n      {field:\"next_milestone\",label:\"Next milestone\",format:\"date\"}]}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.94}
```
Teaches: rename op + I4; the model replaces panels it knows reference the
field; the KERNEL rewrites declared queries of untouched panels (status
filter panels etc.) via the rename map — the model need not enumerate them.
