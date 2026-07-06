# Exemplar 12 — Cards view, replacing a panel in place (Context A)
INTENT: "show my clients as cards instead of a table"

```json
{"api":1,
 "summary":"Shows your clients as a card gallery instead of a table.",
 "user_facing_diff":[
   {"kind":"change_panel","detail":"Client list is now a card gallery"}],
 "clarifying_question":null,
 "assumptions":[],
 "migration":null,
 "panels":[{
   "panel_id":"client_list","title":"Clients",
   "placement":{"region":"main","order":0},
   "declared_queries":[{"from":"clients",
     "orderBy":[{"field":"last_visit","dir":"desc"}]}],
   "declared_writes":[],
   "code":"export default function(clay){\n  clay.db.watch({from:\"clients\",orderBy:[{field:\"last_visit\",dir:\"desc\"}]},(rows)=>{\n    clay.ui.render(rows.length===0\n      ? h(EmptyState,{label:\"No clients yet\"})\n      : h(Cards,{items:rows.map((c)=>({title:c.name,subtitle:c.dog_name,\n          fields:[{label:\"Phone\",value:c.phone},{label:\"Last visit\",value:c.last_visit}]}))}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.9}
```
Teaches: Cards for a record gallery; REUSING an existing panel_id
(client_list) REPLACES it — so the diff is change_panel, not add_panel;
whole-file replacement of the panel with the new component.
