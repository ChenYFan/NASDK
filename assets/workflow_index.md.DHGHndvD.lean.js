import{_ as s,C as t,o as n,c as A,a3 as c,E as N,j as r,a}from"./chunks/framework.BLaSdaBb.js";const m=JSON.parse('{"title":"任务与流水线","description":"","frontmatter":{},"headers":[],"relativePath":"workflow/index.md","filePath":"workflow/index.md","lastUpdated":1788343005000}'),i={name:"workflow/index.md"};function l(p,e,d,C,P,_){const o=t("VitePressMermaid");return n(),A("div",null,[e[0]||(e[0]=c("",4)),N(o,{value:`flowchart TB
    NApp["NApp<br/>上游门面"]
    NACP["NACP<br/>接收Request"]
    NACT["NACT<br/>传输层"]

    Processor["Processor<br/>统一处理接口"]
    NACEB["NACEB<br/>多步骤事件处理"]
    NACAB["NACAB<br/>单次能力调用"]


    NACP <--> Processor
    Processor <-...-> NACEB
    Processor <-...-> NACAB`}),e[1]||(e[1]=r("p",null,[r("a",{href:"./naceb"},"NACEB"),a(" 是NASDK内建的事件处理器，通过 Event、Pipeline 与 Task 执行多步骤任务，并协调任务所需的有限资源。")],-1)),e[2]||(e[2]=r("p",null,[r("a",{href:"./nacab"},"NACAB"),a(" 是NASDK内建的能力处理器，执行一次调用、一次返回的独立能力。")],-1))])}const B=s(i,[["render",l]]);export{m as __pageData,B as default};
