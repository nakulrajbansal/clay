# Exemplar 16 — a whole app in blueprints: migration + one line per panel
INTENT: "build me a simple expense approvals app"

```json
{"api":1,
 "summary":"Builds an expense approvals app: requests move submitted → approved → paid, with a summary, a table, and a submit form.",
 "user_facing_diff":[
   {"kind":"add_field","detail":"Expenses table (title, requester, amount, stage, submitted on)"},
   {"kind":"add_panel","detail":"At-a-glance totals"},
   {"kind":"add_panel","detail":"Approval workflow with one-click advancing"},
   {"kind":"add_panel","detail":"All expenses table"},
   {"kind":"add_panel","detail":"Submit-expense form"}],
 "clarifying_question":null,
 "assumptions":["Stages are submitted, approved, paid"],
 "migration":{
   "operations":[
     {"op":"create_table","table":"expenses","columns":[
       {"name":"title","type":"text","required":true},
       {"name":"requester","type":"text","required":false},
       {"name":"amount","type":"number","required":false},
       {"name":"stage","type":"enum","required":false,"values":["submitted","approved","paid"]},
       {"name":"submitted_on","type":"date","required":false}]}],
   "inverse":[{"op":"drop_table_if_created_by_this","table":"expenses"}]},
 "panels":[
  {"panel_id":"expense_metrics","title":"At a glance",
   "placement":{"region":"top","order":0},
   "declared_queries":[],
   "code":"//#blueprint {\"kind\":\"metrics\",\"table\":\"expenses\",\"metrics\":[{\"label\":\"Requests\",\"agg\":\"count\",\"field\":\"title\"},{\"label\":\"Total requested\",\"agg\":\"sum\",\"field\":\"amount\",\"format\":\"currency\"}]}"},
  {"panel_id":"expense_flow","title":"Approvals",
   "placement":{"region":"main","order":0},
   "declared_queries":[],
   "code":"//#blueprint {\"kind\":\"flow\",\"table\":\"expenses\",\"stage\":\"stage\",\"item\":{\"title\":\"title\",\"subtitle\":\"requester\",\"badge\":\"amount\"}}"},
  {"panel_id":"expense_table","title":"All expenses",
   "placement":{"region":"main","order":1},
   "declared_queries":[],
   "code":"//#blueprint {\"kind\":\"table\",\"table\":\"expenses\",\"sort\":{\"field\":\"submitted_on\",\"dir\":\"desc\"}}"},
  {"panel_id":"expense_form","title":"Submit an expense",
   "placement":{"region":"side","order":0},
   "declared_queries":[],
   "code":"//#blueprint {\"kind\":\"form\",\"table\":\"expenses\",\"defaults\":{\"stage\":\"submitted\"},\"submitLabel\":\"Submit\"}"}],
 "remove_panels":[],
 "confidence":0.94}
```
Teaches: the fastest correct build — a migration plus ONE LINE per
standard panel. declared_queries/declared_writes stay empty; the kernel
derives them from the same spec as the code, so they cannot mismatch.
Blueprints may target tables created by this same plan's migration.
Custom module code remains for panels no blueprint expresses.
