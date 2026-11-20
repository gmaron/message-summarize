# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue.

Use GitHub Private Vulnerability Reporting: [report a vulnerability](https://github.com/gmaron/message-summarize/security/advisories/new) (or open the repository, go to **Security** and choose **Report a vulnerability**). Describe what you found, how to reproduce it and what it could expose. Use invented data in your reproduction: never include real conversations, phone numbers, API keys or WhatsApp session files.

This is a small project maintained by one person. Reports are read and answered as soon as possible, with no guaranteed response time.

## Supported versions

There is no stable release yet (the project is before 1.0). Only the latest version of the `main` branch, and the latest release once there is one, receive security fixes.

## What counts as a vulnerability

- A leak of conversations: chat content, names or numbers reaching a destination the user did not choose, a "local only" conversation reaching an external provider, or content appearing in logs.
- Sending anything to a third party: any path that makes the program send a message to someone other than the account's own chat.
- Code execution through prompt injection: text written by a third party in a chat that makes an LLM CLI or any other component run commands, read files or use tools on the user's machine.
- Exposure of the WhatsApp session or of secrets: API keys or the session readable by other users of the machine, written to logs, or reachable through the local web page without its access token.
- Access to the local web page or the API from outside the machine, or without the token.

## What does not count

- **The risk that WhatsApp blocks a number** for using an unofficial client. It is inherent to the project, and it is explained in the [README](../README.md#important-warning).
- Behavior of a third-party provider or CLI that you configured yourself, including a generic CLI you accepted with `acknowledgeRisk`, which the program warns about.
- Vulnerabilities in a dependency with no way to reach them from this program (report those upstream). The dependencies are listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
- Problems that need an attacker who already controls the user's account on the machine.
