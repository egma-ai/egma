# Egma


Egma is an open-source platform for testing voice agents and monitoring them in production.

[Docs](https://docs.egma.ai) · [Egma Cloud](https://app.egma.ai) · [Discord](https://discord.gg/v4KHSNHfPj)


## 🧩 Core features


- **Test before you ship.** Build regression suites with simulated voice and text conversations and mocked tool responses. Keep tests in your agent's repository and run them with the Egma CLI or a coding agent.
- **Monitor production.** Review real conversations, tool calls, and metrics. Use graders to check your agent's behavior and investigate failures.
- **Bring your own keys.** Use your own API keys for model providers on Egma Cloud or when you self-host. You pay providers directly, with no Egma markup on model usage.
- **Customize your tests.** Choose from supported models and customize your caller personas. Set grading instructions and pass thresholds for the behavior you want to test.

Egma supports LiveKit (JS/TS) and Retell. Contact us on Discord to request another platform or feature.


## 🚀 Get started


Run your first voice simulation in as little as five minutes.

Open your voice agent's repository in your coding agent and paste:

```text
Set up Egma in this repo. Install its skills with
npx skills add egma-ai/egma, then use them to connect
my voice agent and run my first voice simulation.
```

For Egma Cloud, [create an account](https://app.egma.ai) and use the prompt above.
To self-host, follow the [self-hosting guide](https://docs.egma.ai/self-hosting)
and include your instance's URL in the prompt. Allow extra time for installation
and the first build.


## 🖥️ Self-hosting


Run Egma on your own machine

```bash
git clone https://github.com/egma-ai/egma.git
cd egma
npm install --global egma-cli
cp .env.example .env
chmod 600 .env
```

Configure `.env` using the [self-hosting guide](https://docs.egma.ai/self-hosting), then start Egma:

```bash
egma self-host up
```

Open [localhost:3101](http://localhost:3101) and create your account.
See the [self-hosting guide](https://docs.egma.ai/self-hosting) for connecting
your agent, server setup, and troubleshooting.


## 🧭 Where we're headed


Egma supports testing and production monitoring today. We plan to add automatic
fixes: Egma would use a production failure to propose a change to your voice
agent's harness, test it, and open a pull request for you to review.


## 💬 Help and feedback

Read the [docs](https://docs.egma.ai)

Join [Discord](https://discord.gg/v4KHSNHfPj)

Open a [GitHub issue](https://github.com/egma-ai/egma/issues)


## ⚖️ License


This repository is MIT licensed, except for the `ee` folders. See
[LICENSE](LICENSE) for more details.
