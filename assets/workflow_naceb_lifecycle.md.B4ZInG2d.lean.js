import{_ as c,C as i,o as r,c as s,j as d,a,E as n,a3 as o}from"./chunks/framework.BLaSdaBb.js";const h=JSON.parse('{"title":"NACEB 生命周期","description":"","frontmatter":{},"headers":[],"relativePath":"workflow/naceb/lifecycle.md","filePath":"workflow/naceb/lifecycle.md","lastUpdated":1788343005000}'),p={name:"workflow/naceb/lifecycle.md"};function l(u,e,k,g,T,b){const t=i("VitePressMermaid");return r(),s("div",null,[e[0]||(e[0]=d("h1",{id:"naceb-生命周期",tabindex:"-1"},[a("NACEB 生命周期 "),d("a",{class:"header-anchor",href:"#naceb-生命周期","aria-label":'Permalink to "NACEB 生命周期"'},"​")],-1)),e[1]||(e[1]=d("p",null,"NACEB 有三层状态机，每层都具有自己的FSMController。",-1)),e[2]||(e[2]=d("p",null,"本章仅用于介绍所有的状态机与迁移状态，具体触发迁移详情请参考事件处理部分。",-1)),e[3]||(e[3]=d("h2",{id:"event-层",tabindex:"-1"},[a("Event 层 "),d("a",{class:"header-anchor",href:"#event-层","aria-label":'Permalink to "Event 层"'},"​")],-1)),n(t,{value:`flowchart TD
    START((*)) -->|pushEvent| idle
    idle -->|start 且有 blockedBy| blocked
    idle -->|start 且无 blockedBy| queue
    blocked -->|前置都终局或不存在| queue
    queue -->|同 scope 无占用| activating
    activating -->|当前 task 是 blocked| processing
    activating -->|当前 task 是 async| pending
    processing -->|换成 async task| pending
    pending -->|换成 blocked task| processing
    processing -->|Event.pause| paused
    pending -->|Event.pause| paused
    paused -->|resume（blocked）| processing
    paused -->|resume（async）| pending
    processing -->|pipeline done| done([done])
    pending -->|pipeline done| done
    processing -->|pipeline failure| failure([failure])
    pending -->|pipeline failure| failure`}),e[4]||(e[4]=o("",2)),n(t,{value:`flowchart TD
    START((*)) -->|Event activating 副作用| pending
    pending -->|next 派下一个 task| running
    running -->|next 派下一个 task（同态）| running
    running -->|task stopped| paused
    running -->|$terminal task done| done([done])
    running -->|task failure 或 next 异常| failure([failure])
    paused -->|resume| running`}),e[5]||(e[5]=o("",2)),n(t,{value:`flowchart TD
    START((*)) -->|TaskFSMController.dispatch| pending
    pending -->|放行| running
    pending -->|未放行即被 pause 打断| stopped
    running -->|正常 return| done([done])
    running -->|abort 中断，提前收尾| stopped
    running -->|execute throw| failure([failure])
    stopped -->|restart 重启| pending`}),e[6]||(e[6]=o("",8)),n(t,{value:`sequenceDiagram
    participant Caller as 调用方
    participant Event as Event Instance
    participant Pipeline as Pipeline Instance
    participant Task as Task Instance
    participant TaskHandler

    Caller->>Event: pause()
    Event->>Event: → paused
    Event->>Pipeline: _pause()
    Pipeline->>Pipeline: → paused
    Pipeline->>Task: _stop()
    Task->>Task: AbortController.abort()
    Task->>TaskHandler: onSignal(abort)
    TaskHandler-->>Task: execute() 结束
    Task->>Task: → stopped
    Task-->>Pipeline: 终止结果
    Pipeline->>Pipeline: → paused
    Pipeline-->>Event: 暂停结果
    Event-->>Event: → paused

    Event-->>Caller: 暂停结果

    Note over Caller,TaskHandler: 恢复
    Caller->>Event: resume()
    Event->>Pipeline: _resume()
    Pipeline->>Task: _restart()
    Task->>TaskHandler: 重置AbortController
    Task->>Task: → pending
    Task-->>Pipeline: 重启完成
    Pipeline->>Pipeline: paused → running
    Pipeline-->>Event: 恢复结果
    Event->>Event: → processing / pending
    Event-->>Caller: 恢复结果

    Note over Task,TaskHandler: Next Tick
    Task->>Task: pending → running
    Task->>TaskHandler: execute()`})])}const E=c(p,[["render",l]]);export{h as __pageData,E as default};
