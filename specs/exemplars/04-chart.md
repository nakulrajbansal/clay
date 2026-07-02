# Exemplar 4 — chart panel with aggregate (Context C)
INTENT: "show a chart of how many books I finish per month"

```json
{"api":1,
 "summary":"Adds a bar chart of books finished per month.",
 "user_facing_diff":[
   {"kind":"add_chart","detail":"Books finished per month (bar chart)"}],
 "clarifying_question":null,
 "assumptions":["Months keyed by the finished date; unfinished books excluded"],
 "migration":null,
 "panels":[{
   "panel_id":"finished_per_month","title":"Finished per month",
   "placement":{"region":"main","order":1},
   "declared_queries":[{"from":"books",
     "where":[{"field":"finished","op":"not_null"}],
     "select":["finished"]}],
   "code":"export default function(clay){\n  const q={from:\"books\",where:[{field:\"finished\",op:\"not_null\"}],select:[\"finished\"]};\n  clay.db.watch(q,(rows)=>{\n    const byMonth={};\n    for(const r of rows){const m=r.finished.slice(0,7);byMonth[m]=(byMonth[m]||0)+1;}\n    const data=Object.keys(byMonth).sort().map(m=>({x:m,y:byMonth[m]}));\n    clay.ui.render(data.length===0\n      ? h(EmptyState,{label:\"Finish a book to see this chart\"})\n      : h(Chart,{kind:\"bar\",data,xLabel:\"Month\",yLabel:\"Books\",height:220}));\n  });\n}"}],
 "remove_panels":[],
 "confidence":0.92}
```
Teaches: migration:null for pure-UI mutations (R4); light in-panel data
shaping is fine; Chart is a spec, not drawing code.
