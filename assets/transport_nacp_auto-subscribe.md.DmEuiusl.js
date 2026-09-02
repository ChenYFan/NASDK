import{_ as a,C as t,o as u,c,a3 as r,E as n,j as s,a as i}from"./chunks/framework.BLaSdaBb.js";const R=JSON.parse('{"title":"AutoSubscribe","description":"","frontmatter":{},"headers":[],"relativePath":"transport/nacp/auto-subscribe.md","filePath":"transport/nacp/auto-subscribe.md","lastUpdated":1788343005000}'),b={name:"transport/nacp/auto-subscribe.md"};function p(d,e,l,A,q,h){const o=t("VitePressMermaid");return u(),c("div",null,[e[0]||(e[0]=r('<h1 id="autosubscribe" tabindex="-1">AutoSubscribe <a class="header-anchor" href="#autosubscribe" aria-label="Permalink to &quot;AutoSubscribe&quot;">​</a></h1><p>NACP将在发起Event Request时自动订阅过程流，并在结束后自动退订。</p><p>这一机制被称为<code>AutoSubscribe</code></p><h2 id="为什么需要-autosubscribe" tabindex="-1">为什么需要 AutoSubscribe <a class="header-anchor" href="#为什么需要-autosubscribe" aria-label="Permalink to &quot;为什么需要 AutoSubscribe&quot;">​</a></h2><p>NACP 不只传输<code>一发一收</code>的消息，还需要承载具有生命周期的 Event，任务开始后可以持续产生过程数据，最后再给出唯一的终局结果。</p><p><a href="/workflow/processor">NASDK Processor</a> 将任务处理统一为 <code>onProcess</code> 与 <code>onResponse</code>，AutoSubscribe 则把这两个出口映射到 NACP。</p><p>两者共同把任务处理生命周期与传输协议连接起来，Processor 不需要管理远端订阅，NACP 也不需要理解任务内部状态，只通过 <code>reqId</code> 关联过程流与最终结果。</p><p>如果没有 AutoSubscribe，一次完整的 Event Request 只能先发送 Request，取得并围绕这次请求建立过程流订阅，最后再主动退订：</p>',8)),n(o,{value:`sequenceDiagram
    participant A as 请求方 App A
    participant B as 接收方 App B

    Note over A: 构造 Request，得到 reqId
    A->>B: Request
    B-->>A: ACK
    Note over B: Request 已开始处理
    B--xA: Sub建立前消息（尚未订阅，丢失）

    Note over A: 以 reqId 构造 Subscribe
    A->>B: Subscribe
    B-->>A: ACK
    Note over B: 建立过程流转发监听
    B->>A: Response
    A-->>B: ACK
    Note over A: 保存订阅 ID，开始监听

    B-->>A: 后续 0..N Notify
    Note over B: Request 处理结束
    B->>A: Response
    A-->>B: ACK

    Note over A: 构造 Unsubscribe
    A->>B: Unsubscribe
    B-->>A: ACK
    Note over B: 移除过程流转发监听
    B->>A: Response
    A-->>B: ACK
    Note over A: 移除本地接收记录`}),e[1]||(e[1]=s("p",null,"这套流水线有两个问题：",-1)),e[2]||(e[2]=s("ul",null,[s("li",null,"Request 先开始工作，Subscribe 后建立，在这段时间内产生的过程消息没有转发监听，会直接丢失。"),s("li",null,"每次 Event Request 都会额外产生一组 Subscribe / Ack / Response 和 Unsubscribe / Ack / Response 往返。")],-1)),e[3]||(e[3]=s("h2",{id:"eventrequest自动监听",tabindex:"-1"},[i("EventRequest自动监听 "),s("a",{class:"header-anchor",href:"#eventrequest自动监听","aria-label":'Permalink to "EventRequest自动监听"'},"​")],-1)),e[4]||(e[4]=s("p",null,"AutoSubscribe 将订阅的建立和清理并入 Request / Response 生命周期：",-1)),n(o,{value:`sequenceDiagram
    participant A as 请求方 App A
    participant B as 接收方 App B

    Note over A: 构造 Request，得到 reqId
    A->>A: 虚拟出站SubScribe
    A->>B: Request
    B-->>A: ACK
    B->>B: 虚拟入站SubScribe
    B-->>A: 0..N Notify
    Note over B: 提交 Response
    B->>B: 虚拟入站UnSubScribe
    B->>A: Response
    A-->>B: ACK
    A->>A: 虚拟出站UnSubScribe`}),e[5]||(e[5]=r('<div class="tip custom-block"><p class="custom-block-title">TIP</p><p>“虚拟”的含义表示NACP<strong>复用了</strong>既有的监听和取消流程，但不发送消息到出入站接口，也不等待ACK和Response。</p><p>这会导致少量副作用：</p><ul><li><code>nacp:outbound|inbound:subscribe|unsubscribe</code> 事件将不会被广播</li><li>SubId将不再自动生成，而是被设置为<code>ReqID</code></li></ul></div><h2 id="request-构建与发送" tabindex="-1">Request 构建与发送 <a class="header-anchor" href="#request-构建与发送" aria-label="Permalink to &quot;Request 构建与发送&quot;">​</a></h2><h3 id="请求方" tabindex="-1">请求方 <a class="header-anchor" href="#请求方" aria-label="Permalink to &quot;请求方&quot;">​</a></h3><p>请求方先构造 RequestMessage，取得 <code>reqId</code>，再虚拟出站 Subscribe。</p><p>虚拟出站 Subscribe 复用 <a href="./outbound/subscribe"><code>subscribe()</code></a> 建立请求方的 ListenTable 记录，但不会发送 SubscribeMessage。</p><p>该记录在 Request 真正出站前已经存在，可以立即接收以 <code>reqId</code> 为 <code>parentId</code> 的 Notify。</p><h3 id="接收方" tabindex="-1">接收方 <a class="header-anchor" href="#接收方" aria-label="Permalink to &quot;接收方&quot;">​</a></h3><p>接收方收到 Event Request 后，会先在移交 Processor 之前虚拟入站 Subscribe，最后才会移交给Processor。</p><p>虚拟入站 Subscribe 复用 <a href="./inbound/on-subscribe"><code>onSubscribe()</code></a>，但不会接收真实 SubscribeMessage，也不会发送 Subscribe Response。</p><div class="tip custom-block"><p class="custom-block-title">TIP</p><p>由于监听先于 Processor 建立，Processor 一开始产生的过程消息也不会丢失。</p></div><h2 id="response-提交与接收" tabindex="-1">Response 提交与接收 <a class="header-anchor" href="#response-提交与接收" aria-label="Permalink to &quot;Response 提交与接收&quot;">​</a></h2><h3 id="接收方-1" tabindex="-1">接收方 <a class="header-anchor" href="#接收方-1" aria-label="Permalink to &quot;接收方&quot;">​</a></h3><p>Processor 结束后，接收方提交 <code>Response(parentId = reqId, kind = &quot;event&quot;)</code>，随后虚拟入站 Unsubscribe，移除监听器。</p><p>该过程复用 <a href="./inbound/on-unsubscribe"><code>onUnsubscribe()</code></a>，但不会接收真实 UnsubscribeMessage，也不会发送 Unsubscribe Response。</p><h3 id="请求方-1" tabindex="-1">请求方 <a class="header-anchor" href="#请求方-1" aria-label="Permalink to &quot;请求方&quot;">​</a></h3><p>请求方收到 Event Response 后，会虚拟出站 Unsubscribe，移除本地接收器。</p><p>该过程复用 <a href="./outbound/unsubscribe"><code>unsubscribe()</code></a>，但不会发送真实 UnsubscribeMessage，也不会等待 Unsubscribe Response。</p><h2 id="异常清理" tabindex="-1">异常清理 <a class="header-anchor" href="#异常清理" aria-label="Permalink to &quot;异常清理&quot;">​</a></h2><p>AutoSubscribe正常的异常情况和普通Subscribe无异，详情见<a href="/transport/nacp/lifecycle">生命周期</a>。</p><p>相关流程见 <a href="./outbound/request"><code>request()</code></a>、<a href="./inbound/on-request"><code>onRequest()</code></a> 和 <a href="./inbound/on-response"><code>onResponse()</code></a>。</p>',20))])}const B=a(b,[["render",p]]);export{R as __pageData,B as default};
