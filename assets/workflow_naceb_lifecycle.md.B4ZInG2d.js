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
    pending -->|pipeline failure| failure`}),e[4]||(e[4]=o('<table tabindex="0"><thead><tr><th>状态名</th><th>含义</th><th>从何而来</th><th>到哪里去</th></tr></thead><tbody><tr><td><code>idle</code></td><td>Event 创建时默认状态</td><td><code>pushEvent()</code></td><td><code>start()</code> 后<br>进入<code>blocked</code>/<code>queue</code></td></tr><tr><td><code>blocked</code></td><td>Event 被前置事件阻塞</td><td><code>start()</code>时带有 <code>blockedBy</code> 参数</td><td>前置 Event 不再阻塞时<br>进入<code>queue</code></td></tr><tr><td><code>queue</code></td><td>Event 已就绪，等待执行</td><td><code>start()</code>后<br>或<code>blocked</code>结束</td><td>同 scope 无 Event竞争<br>进入<code>activating</code></td></tr><tr><td><code>activating</code></td><td>Event 激活中，准备运行</td><td><code>queue</code>结束</td><td>根据第一步任务类型<br>进入 <code>processing</code>或<code>pending</code></td></tr><tr><td><code>processing</code></td><td>Pipeline 当前运行 blocked Task</td><td><code>activating</code>、<code>pending</code>、<code>paused</code></td><td>根据下一步进入<code>pending</code>、<code>processing</code>或<code>pause</code>、终态</td></tr><tr><td><code>pending</code></td><td>Pipeline 当前运行 async Task</td><td><code>activating</code>、<code>pending</code>、<code>paused</code></td><td>根据下一步进入<code>pending</code>、<code>processing</code>或<code>pause</code>、终态</td></tr><tr><td><code>paused</code></td><td>Event 对应 Pipeline 暂停</td><td>对 Event 调用 <code>pause()</code></td><td><code>resume()</code> 后根据任务类型<br>进入 <code>processing</code>或<code>pending</code></td></tr><tr><td><code>done</code></td><td>Event 正常结束，终态</td><td><code>processing</code> 或 <code>pending</code> 对应的 Pipeline 进入 <code>done</code></td><td>-</td></tr><tr><td><code>failure</code></td><td>Event 异常结束，终态</td><td>任意状态发生失败均可直接进入</td><td>-</td></tr></tbody></table><h2 id="pipeline-层" tabindex="-1">Pipeline 层 <a class="header-anchor" href="#pipeline-层" aria-label="Permalink to &quot;Pipeline 层&quot;">​</a></h2>',2)),n(t,{value:`flowchart TD
    START((*)) -->|Event activating 副作用| pending
    pending -->|next 派下一个 task| running
    running -->|next 派下一个 task（同态）| running
    running -->|task stopped| paused
    running -->|$terminal task done| done([done])
    running -->|task failure 或 next 异常| failure([failure])
    paused -->|resume| running`}),e[5]||(e[5]=o('<table tabindex="0"><thead><tr><th>状态名</th><th>含义</th><th>从何而来</th><th>到哪里去</th></tr></thead><tbody><tr><td><code>pending</code></td><td>Pipeline 创建时默认状态</td><td>Event 进入 <code>activating</code></td><td>派发 Task 后进入 <code>running</code></td></tr><tr><td><code>running</code></td><td>Pipeline 当前已有 Task 运行</td><td><code>pending</code>、<code>running</code>、<code>paused</code></td><td>根据下一步进入 <code>running</code>、<code>paused</code> 或终态</td></tr><tr><td><code>paused</code></td><td>Pipeline 暂停</td><td>Task 进入 <code>stopped</code></td><td><code>resume()</code> 后进入 <code>running</code></td></tr><tr><td><code>done</code></td><td>Pipeline 正常结束，终态</td><td><code>$terminal</code> Task 完成</td><td>-</td></tr><tr><td><code>failure</code></td><td>Pipeline 异常结束，终态</td><td>任意状态发生失败均可直接进入</td><td>-</td></tr></tbody></table><h2 id="task-层" tabindex="-1">Task 层 <a class="header-anchor" href="#task-层" aria-label="Permalink to &quot;Task 层&quot;">​</a></h2>',2)),n(t,{value:`flowchart TD
    START((*)) -->|TaskFSMController.dispatch| pending
    pending -->|放行| running
    pending -->|未放行即被 pause 打断| stopped
    running -->|正常 return| done([done])
    running -->|abort 中断，提前收尾| stopped
    running -->|execute throw| failure([failure])
    stopped -->|restart 重启| pending`}),e[6]||(e[6]=o('<table tabindex="0"><thead><tr><th>状态名</th><th>含义</th><th>从何而来</th><th>到哪里去</th></tr></thead><tbody><tr><td><code>pending</code></td><td>Task 已派发，等待执行</td><td><code>dispatch()</code><br>或 <code>stopped</code> 重启</td><td>条件满足后进入 <code>running</code><br>暂停时进入 <code>stopped</code></td></tr><tr><td><code>running</code></td><td>TaskHandler 执行中</td><td><code>pending</code></td><td>正常结束进入 <code>done</code><br>暂停进入 <code>stopped</code><br>异常进入 <code>failure</code></td></tr><tr><td><code>stopped</code></td><td>Task 已暂停，可重新启动</td><td><code>pending</code> 或 <code>running</code> 时暂停</td><td><code>restart()</code> 后进入 <code>pending</code></td></tr><tr><td><code>done</code></td><td>Task 正常结束，终态</td><td>TaskHandler 正常返回</td><td>-</td></tr><tr><td><code>failure</code></td><td>Task 异常结束，终态</td><td>任意状态发生失败均可直接进入</td><td>-</td></tr></tbody></table><div class="info custom-block"><p class="custom-block-title">INFO</p><p>重启后 Instance 会保留，同时保留所有的 hook 和 state，便于内部重建。</p></div><h2 id="消费" tabindex="-1">消费 <a class="header-anchor" href="#消费" aria-label="Permalink to &quot;消费&quot;">​</a></h2><p>所有队列在进入 done 或 failure 后都不会自己被清除。</p><p>NACEB 对完成的实例没有「清除」概念，取而代之的是「消费」。</p><p>「消费 Consume」的含义是：取走这个实例的结果，并清空结果输出，标记这个结果被「消费掉了」。</p><div class="warning custom-block"><p class="custom-block-title">WARNING</p><p>对非终态 event 进行 <code>consumeEvent</code> 将直接抛错，这是为了防止误清还在运行的 event。</p></div><h2 id="暂停与恢复" tabindex="-1">暂停与恢复 <a class="header-anchor" href="#暂停与恢复" aria-label="Permalink to &quot;暂停与恢复&quot;">​</a></h2>',8)),n(t,{value:`sequenceDiagram
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
