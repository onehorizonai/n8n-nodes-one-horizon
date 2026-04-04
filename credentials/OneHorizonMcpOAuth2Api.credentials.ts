import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

export class OneHorizonMcpOAuth2Api implements ICredentialType {
	name = 'oneHorizonMcpOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'One Horizon MCP OAuth2 API';

	icon: Icon = { light: 'file:../icons/onehorizon.svg', dark: 'file:../icons/onehorizon.dark.svg' };

	documentationUrl = 'https://onehorizon.ai/docs/integrations/n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'Use Dynamic Client Registration',
			name: 'useDynamicClientRegistration',
			type: 'boolean',
			default: true,
		},
	];
}
