import { defineConfig } from "vitepress";
import { mermaidPlugin } from "./plugins/mermaid";

export default defineConfig({
  lang: "zh-CN",
  title: "NASDK",
  description: "多应用通信与有限资源工作流运行时",
  appearance: "dark",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        sizes: "180x180",
        href: "/NASDK-180.png",
      },
    ],
    [
      "link",
      { rel: "apple-touch-icon", sizes: "180x180", href: "/NASDK-180.png" },
    ],
  ],
  themeConfig: {
    logo: {
      light: "/NASDK.png",
      dark: "/NASDK-Dark.png",
    },
    nav: [
      { text: "NApp", link: "/napp/what-is-nasdk" },
      { text: "传输与协议", link: "/transport/" },
      { text: "任务与流水线", link: "/workflow/" },
      { text: "设计准则与 API", link: "/design/principles" },
    ],
    sidebar: {
      "/napp/": [
        {
          text: "快速开始",
          items: [
            { text: "What is NASDK？", link: "/napp/what-is-nasdk" },
            { text: "Why NASDK？", link: "/napp/why-nasdk" },
            { text: "Hello，World！", link: "/napp/hello-world" },

            {
              text: "NApp",
              items: [
                { text: "构建完整一个 NApp", link: "/napp/construction" },
                {
                  text: "能力",
                  items: [
                    { text: "request", link: "/napp/abilities/request" },
                    { text: "response", link: "/napp/abilities/response" },
                    { text: "subscribe", link: "/napp/abilities/subscribe" },
                    {
                      text: "unsubscribe",
                      link: "/napp/abilities/unsubscribe",
                    },
                    { text: "notify", link: "/napp/abilities/notify" },
                    { text: "signal", link: "/napp/abilities/signal" },
                  ],
                },
                {
                  text: "进阶",
                  items: [
                    { text: "NApp 生命周期", link: "/napp/advanced/lifecycle" },
                    { text: "NApp as Gateway", link: "/napp/advanced/gateway" },
                    {
                      text: "NApp 可观测",
                      link: "/napp/advanced/observability",
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          text: "EventBus",
          items: [
            { text: "简介", link: "/napp/eventbus" },
            { text: "API", link: "/napp/eventbus/bus" },
          ],
        },
      ],
      "/transport/": [
        {
          text: "传输与协议",
          items: [
            { text: "传输层总览", link: "/transport/" },
            { text: "什么是NACP", link: "/transport/nacp" },
            { text: "什么是NACT", link: "/transport/nact" },
          ],
        },
        {
          text: "NACP",
          items: [
            { text: "NACPMessage", link: "/transport/nacp/message" },
            {
              text: "出站",
              link: "/transport/nacp/outbound",
              items: [
                { text: "request", link: "/transport/nacp/outbound/request" },
                { text: "response", link: "/transport/nacp/outbound/response" },
                { text: "signal", link: "/transport/nacp/outbound/signal" },
                {
                  text: "subscribe",
                  link: "/transport/nacp/outbound/subscribe",
                },
                {
                  text: "unsubscribe",
                  link: "/transport/nacp/outbound/unsubscribe",
                },
                { text: "notify", link: "/transport/nacp/outbound/notify" },
                { text: "register", link: "/transport/nacp/outbound/register" },
                {
                  text: "unregister",
                  link: "/transport/nacp/outbound/unregister",
                },
                { text: "ack", link: "/transport/nacp/outbound/ack" },
              ],
            },

            {
              text: "入站",
              link: "/transport/nacp/inbound",
              items: [
                {
                  text: "onRequest",
                  link: "/transport/nacp/inbound/on-request",
                },
                {
                  text: "onResponse",
                  link: "/transport/nacp/inbound/on-response",
                },
                {
                  text: "onSignal",
                  link: "/transport/nacp/inbound/on-signal",
                },
                {
                  text: "onSubscribe",
                  link: "/transport/nacp/inbound/on-subscribe",
                },
                {
                  text: "onUnsubscribe",
                  link: "/transport/nacp/inbound/on-unsubscribe",
                },
                { text: "onNotify", link: "/transport/nacp/inbound/on-notify" },
                {
                  text: "onRegister",
                  link: "/transport/nacp/inbound/on-register",
                },
                {
                  text: "onUnregister",
                  link: "/transport/nacp/inbound/on-unregister",
                },
                { text: "onAck", link: "/transport/nacp/inbound/on-ack" },
              ],
            },
            {
              text: "进阶",
              items: [
                {
                  text: "AutoSubscribe",
                  link: "/transport/nacp/auto-subscribe",
                },
                { text: "生命周期", link: "/transport/nacp/lifecycle" },
                { text: "可观测", link: "/transport/nacp/observability" },
                { text: "内部记录表", link: "/transport/nacp/tables" },
              ],
            },
          ],
        },
        {
          text: "NACT",
          items: [
            { text: "NACT Framing", link: "/transport/nact/framing" },
            { text: "底层传输", link: "/transport/nact/transport" },
            { text: "入站与出站", link: "/transport/nact/inbound-outbound" },
            {
              text: "进阶",
              items: [
                { text: "生命周期", link: "/transport/nact/lifecycle" },
                { text: "可观测", link: "/transport/nact/observability" },
              ],
            },
          ],
        },
      ],
      "/workflow/": [
        {
          text: "任务与流水线",
          items: [
            { text: "什么是NACEB", link: "/workflow/naceb" },
            { text: "什么是NACAB", link: "/workflow/nacab" },

            { text: "什么是NASDK Processor", link: "/workflow/processor" },
          ],
        },
        {
          text: "NACEB",
          items: [
            { text: "构造一个 NACEB", link: "/workflow/naceb/construction" },
            { text: "生命周期", link: "/workflow/naceb/lifecycle" },
            {
              text: "Handler 与事件别名",
              items: [
                { text: "EventAlias", link: "/workflow/naceb/event-alias" },
                { text: "Event", link: "/workflow/naceb/event" },
                { text: "Pipeline", link: "/workflow/naceb/pipeline" },
                { text: "Task", link: "/workflow/naceb/task" },
              ],
            },

            {
              text: "内建任务与子事件",
              items: [
                { text: "$terminal", link: "/workflow/naceb/terminal" },
                {
                  text: "$fire4SubEvent",
                  link: "/workflow/naceb/fire4subevent",
                },
                {
                  text: "$wait4SubEvent",
                  link: "/workflow/naceb/wait4subevent",
                },
              ],
            },
            { text: "刻", link: "/workflow/naceb/tick" },
            {
              text: "可观测",
              items: [
                {
                  text: "Hook",
                  link: "/workflow/naceb/observability/hook",
                  items: [
                    {
                      text: "Veto机制",
                      link: "/workflow/naceb/observability/hook/veto",
                    },
                  ],
                },
                { text: "Event", link: "/workflow/naceb/observability/event" },
              ],
            },
          ],
        },
        {
          text: "NACAB",
          items: [
            { text: "构造一个 NACAB", link: "/workflow/nacab/construction" },
            { text: "生命周期", link: "/workflow/nacab/lifecycle" },
          ],
        },
        {
          text: "NASDK Processor",
          items: [
            {
              text: "Event Processor",
              link: "/workflow/processor/event-processor",
            },
            {
              text: "Ability Processor",
              link: "/workflow/processor/ability-processor",
            },
          ],
        },
      ],
      "/design/": [
        {
          text: "设计准则",
          items: [
            { text: "总体设计原理", link: "/design/principles" },
            { text: "Q&A", link: "/design/qa" },
            { text: "模块边界与职责", link: "/design/boundaries" },
            { text: "可靠性和资源约束", link: "/design/reliability" },
            { text: "各模块类型与函数参考", link: "/design/reference" },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/ChenYFan/NASDK" },
    ],
    search: { provider: "local" },
    outline: { level: [2, 3], label: "本页内容" },
    docFooter: { prev: "上一页", next: "下一页" },
    lastUpdated: { text: "最后更新" },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © CyanFalse",
    },
  },
  markdown: {
    lineNumbers: true,
    config: (md) => md.use(mermaidPlugin),
  },
});
