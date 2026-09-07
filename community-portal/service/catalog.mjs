// Actual partner allowances and activation terms will be added with their integrations.
export function catalog() {
  return [
    { id: 'echo', name: 'Echo', kind: 'account', category: 'Security', headline: 'A hardened home for your agent', description: 'Opt in to Echo’s hardened image for your NanoClaw agent.', allowance: 'Hardened agent image', mode: 'existing', enabled: false },
    { id: 'slack', name: 'Slack', kind: 'account', category: 'Messaging', headline: 'Your agents, in your workspace', description: 'Connect your workspace and bring your agent into Slack.', allowance: 'Managed Slack agents', mode: 'existing', enabled: false },
    { id: 'tavily', name: 'Tavily', category: 'Search', headline: 'Give your agent a view of the web', description: 'Let your agent search the web and retrieve the information it needs.', allowance: 'Web search and extraction', mode: 'unconfigured', enabled: false },
    { id: 'dial', name: 'Dial', category: 'Phone', headline: 'A phone number for your agent', description: 'Give your agent a number for calls and messages.', allowance: 'Calls and messages', mode: 'unconfigured', enabled: false },
  ];
}
