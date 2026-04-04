import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { ApplicationError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

const MCP_CREDENTIAL_TYPE = 'oneHorizonMcpOAuth2Api';
const DEFAULT_MCP_ENDPOINT = 'https://mcp.onehorizon.ai/mcp';

const TASK_STATUS_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Open', value: 'Open' },
	{ name: 'Planned', value: 'Planned' },
	{ name: 'In Progress', value: 'In Progress' },
	{ name: 'In Review', value: 'In Review' },
	{ name: 'Blocked', value: 'Blocked' },
	{ name: 'Completed', value: 'Completed' },
	{ name: 'Cancelled', value: 'Cancelled' },
	{ name: 'Merged', value: 'Merged' },
	{ name: 'Idea', value: 'Idea' },
];

type JsonRpcError = {
	code: number;
	message: string;
	data?: unknown;
};

type JsonRpcSuccess<T> = {
	jsonrpc: string;
	id: string | number | null;
	result: T;
};

type JsonRpcFailure = {
	jsonrpc: string;
	id: string | number | null;
	error: JsonRpcError;
};

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

type McpTool = {
	name: string;
	description?: string;
	inputSchema?: IDataObject;
};

type McpListToolsResult = {
	tools: McpTool[];
	nextCursor?: string;
};

type McpCallToolResult = {
	content?: IDataObject[];
	isError?: boolean;
};

type ToolCall = {
	toolName: string;
	arguments: IDataObject;
};

type OneHorizonContext = IExecuteFunctions | ILoadOptionsFunctions;

function normalizeEndpointUrl(rawEndpointUrl: string): string {
	const trimmed = rawEndpointUrl.trim();
	if (!trimmed) {
		return DEFAULT_MCP_ENDPOINT;
	}

	const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(withProtocol);
	} catch {
		return DEFAULT_MCP_ENDPOINT;
	}

	if (parsedUrl.pathname === '' || parsedUrl.pathname === '/') {
		parsedUrl.pathname = '/mcp';
	}

	return parsedUrl.toString();
}

function splitCommaSeparated(value?: string): string[] | undefined {
	if (!value) return undefined;
	const parts = value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);

	return parts.length > 0 ? parts : undefined;
}

function cleanArguments(argumentsInput: Record<string, unknown>): IDataObject {
	const cleaned: IDataObject = {};
	for (const [key, value] of Object.entries(argumentsInput)) {
		if (value === undefined || value === null) continue;
		if (typeof value === 'string' && value.trim().length === 0) continue;
		if (Array.isArray(value) && value.length === 0) continue;
		cleaned[key] = value as IDataObject[string];
	}
	return cleaned;
}

function isJsonRpcError<T>(response: JsonRpcResponse<T>): response is JsonRpcFailure {
	return 'error' in response;
}

function getOptionalString(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
): string | undefined {
	const value = context.getNodeParameter(name, itemIndex, '') as string;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function getRequiredString(
	context: IExecuteFunctions,
	name: string,
	itemIndex: number,
	errorLabel: string,
): string {
	const value = getOptionalString(context, name, itemIndex);
	if (!value) {
		throw new ApplicationError(`${errorLabel} is required for this operation`);
	}
	return value;
}

function parseRawArguments(
	context: IExecuteFunctions,
	itemIndex: number,
): IDataObject {
	const rawArguments = context.getNodeParameter('rawArguments', itemIndex, {}) as unknown;

	if (typeof rawArguments === 'string') {
		const trimmed = rawArguments.trim();
		if (!trimmed) return {};

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new ApplicationError(`Raw Arguments must be valid JSON: ${message}`);
		}

		if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
			throw new ApplicationError('Raw Arguments must be a JSON object');
		}

		return parsed as IDataObject;
	}

	if (rawArguments === null || Array.isArray(rawArguments) || typeof rawArguments !== 'object') {
		throw new ApplicationError('Raw Arguments must be a JSON object');
	}

	return rawArguments as IDataObject;
}

async function sendJsonRpcRequest<T>(
	context: OneHorizonContext,
	endpointUrl: string,
	method: string,
	params: IDataObject,
): Promise<T> {
	const options: IHttpRequestOptions = {
		method: 'POST',
		url: endpointUrl,
		json: true,
		headers: {
			'Content-Type': 'application/json',
		},
		body: {
			jsonrpc: '2.0',
			id: `onehorizon-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
			method,
			params,
		},
	};

	let response: JsonRpcResponse<T>;
	try {
		response = (await context.helpers.httpRequestWithAuthentication.call(
			context,
			MCP_CREDENTIAL_TYPE,
			options,
		)) as JsonRpcResponse<T>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ApplicationError(`MCP request failed: ${message}`);
	}

	if (isJsonRpcError(response)) {
		const errorSuffix = response.error.code
			? ` (code: ${response.error.code})`
			: '';
		throw new ApplicationError(`${response.error.message}${errorSuffix}`);
	}

	return response.result;
}

async function listTools(
	context: OneHorizonContext,
	endpointUrl: string,
	cursor?: string,
): Promise<McpListToolsResult> {
	const params: IDataObject = {};
	if (cursor) {
		params.cursor = cursor;
	}

	return await sendJsonRpcRequest<McpListToolsResult>(
		context,
		endpointUrl,
		'tools/list',
		params,
	);
}

async function callTool(
	context: IExecuteFunctions,
	endpointUrl: string,
	toolCall: ToolCall,
): Promise<McpCallToolResult> {
	return await sendJsonRpcRequest<McpCallToolResult>(
		context,
		endpointUrl,
		'tools/call',
		{
			name: toolCall.toolName,
			arguments: toolCall.arguments,
		},
	);
}

function getOperationToolCall(context: IExecuteFunctions, itemIndex: number): ToolCall {
	const operation = context.getNodeParameter('operation', itemIndex) as string;

	switch (operation) {
		case 'listPlannedWork': {
			const includeInitiatives = context.getNodeParameter(
				'includeInitiatives',
				itemIndex,
				true,
			) as boolean;

			return {
				toolName: 'list-planned-work',
				arguments: cleanArguments({
					teamId: getOptionalString(context, 'teamId', itemIndex),
					userId: getOptionalString(context, 'userId', itemIndex),
					includeInitiatives,
				}),
			};
		}
		case 'listCompletedWork': {
			const includeInitiatives = context.getNodeParameter(
				'includeInitiatives',
				itemIndex,
				true,
			) as boolean;

			return {
				toolName: 'list-completed-work',
				arguments: cleanArguments({
					startDate: getOptionalString(context, 'startDate', itemIndex),
					endDate: getOptionalString(context, 'endDate', itemIndex),
					teamId: getOptionalString(context, 'teamId', itemIndex),
					userId: getOptionalString(context, 'userId', itemIndex),
					includeInitiatives,
				}),
			};
		}
		case 'listBlockers': {
			const includeInitiatives = context.getNodeParameter(
				'includeInitiatives',
				itemIndex,
				true,
			) as boolean;

			return {
				toolName: 'list-blockers',
				arguments: cleanArguments({
					teamId: getOptionalString(context, 'teamId', itemIndex),
					userId: getOptionalString(context, 'userId', itemIndex),
					includeInitiatives,
				}),
			};
		}
		case 'myWorkRecap': {
			const includeInitiatives = context.getNodeParameter(
				'includeInitiatives',
				itemIndex,
				true,
			) as boolean;

			return {
				toolName: 'my-work-recap',
				arguments: cleanArguments({
					startDate: getOptionalString(context, 'startDate', itemIndex),
					endDate: getOptionalString(context, 'endDate', itemIndex),
					includeInitiatives,
				}),
			};
		}
		case 'teamWorkRecap': {
			const includeInitiatives = context.getNodeParameter(
				'includeInitiatives',
				itemIndex,
				true,
			) as boolean;

			return {
				toolName: 'team-work-recap',
				arguments: cleanArguments({
					teamId: getOptionalString(context, 'teamId', itemIndex),
					startDate: getOptionalString(context, 'startDate', itemIndex),
					endDate: getOptionalString(context, 'endDate', itemIndex),
					includeInitiatives,
				}),
			};
		}
		case 'createTodo': {
			const status = getOptionalString(context, 'todoCreateStatus', itemIndex);
			const isNewFeature = context.getNodeParameter('todoIsNewFeature', itemIndex, false) as boolean;
			const isBugFix = context.getNodeParameter('todoIsBugFix', itemIndex, false) as boolean;
			const isRefactor = context.getNodeParameter('todoIsRefactor', itemIndex, false) as boolean;
			const isDocumentation = context.getNodeParameter('todoIsDocumentation', itemIndex, false) as boolean;
			const isInfrastructure = context.getNodeParameter('todoIsInfrastructure', itemIndex, false) as boolean;
			const isTest = context.getNodeParameter('todoIsTest', itemIndex, false) as boolean;

			return {
				toolName: 'create-todo',
				arguments: cleanArguments({
					workspaceId: getOptionalString(context, 'workspaceId', itemIndex),
					title: context.getNodeParameter('todoTitle', itemIndex) as string,
					topic: context.getNodeParameter('todoTopic', itemIndex) as string,
					status,
					description: getOptionalString(context, 'todoDescription', itemIndex),
					initiativeId: getOptionalString(context, 'todoInitiativeId', itemIndex),
					completedAt: getOptionalString(context, 'todoCompletedAt', itemIndex),
					isNewFeature: isNewFeature ? true : undefined,
					isBugFix: isBugFix ? true : undefined,
					isRefactor: isRefactor ? true : undefined,
					isDocumentation: isDocumentation ? true : undefined,
					isInfrastructure: isInfrastructure ? true : undefined,
					isTest: isTest ? true : undefined,
				}),
			};
		}
		case 'updateTodo': {
			return {
				toolName: 'update-todo',
				arguments: cleanArguments({
					taskId: context.getNodeParameter('todoTaskId', itemIndex) as string,
					workspaceId: getRequiredString(
						context,
						'workspaceId',
						itemIndex,
						'Workspace ID',
					),
					title: getOptionalString(context, 'todoTitle', itemIndex),
					topic: getOptionalString(context, 'todoTopic', itemIndex),
					description: getOptionalString(context, 'todoDescription', itemIndex),
					status: getOptionalString(context, 'todoUpdateStatus', itemIndex),
					completedAt: getOptionalString(context, 'todoCompletedAt', itemIndex),
				}),
			};
		}
		case 'listInitiatives': {
			const statuses = context.getNodeParameter('initiativeStatuses', itemIndex, []) as string[];
			return {
				toolName: 'list-initiatives',
				arguments: cleanArguments({
					workspaceId: getOptionalString(context, 'workspaceId', itemIndex),
					statuses,
					teamIds: splitCommaSeparated(getOptionalString(context, 'initiativeTeamIds', itemIndex)),
					assigneeIds: splitCommaSeparated(getOptionalString(context, 'initiativeAssigneeIds', itemIndex)),
					includeHierarchy: context.getNodeParameter('includeHierarchy', itemIndex, true) as boolean,
				}),
			};
		}
		case 'createInitiative': {
			return {
				toolName: 'create-initiative',
				arguments: cleanArguments({
					workspaceId: getOptionalString(context, 'workspaceId', itemIndex),
					title: context.getNodeParameter('initiativeTitle', itemIndex) as string,
					description: getOptionalString(context, 'initiativeDescription', itemIndex),
					status: getOptionalString(context, 'initiativeCreateStatus', itemIndex),
					parentInitiativeId: getOptionalString(context, 'initiativeParentId', itemIndex),
					assigneeIds: splitCommaSeparated(getOptionalString(context, 'initiativeAssigneeIds', itemIndex)),
					teamIds: splitCommaSeparated(getOptionalString(context, 'initiativeTeamIds', itemIndex)),
					taxonomyLabelIds: splitCommaSeparated(
						getOptionalString(context, 'initiativeTaxonomyLabelIds', itemIndex),
					),
				}),
			};
		}
		case 'updateInitiative': {
			return {
				toolName: 'update-initiative',
				arguments: cleanArguments({
					initiativeId: context.getNodeParameter('initiativeId', itemIndex) as string,
					workspaceId: getRequiredString(
						context,
						'workspaceId',
						itemIndex,
						'Workspace ID',
					),
					title: getOptionalString(context, 'initiativeTitle', itemIndex),
					description: getOptionalString(context, 'initiativeDescription', itemIndex),
					status: getOptionalString(context, 'initiativeUpdateStatus', itemIndex),
					parentInitiativeId: getOptionalString(context, 'initiativeParentId', itemIndex),
					assigneeIds: splitCommaSeparated(getOptionalString(context, 'initiativeAssigneeIds', itemIndex)),
					teamIds: splitCommaSeparated(getOptionalString(context, 'initiativeTeamIds', itemIndex)),
					taxonomyLabelIds: splitCommaSeparated(
						getOptionalString(context, 'initiativeTaxonomyLabelIds', itemIndex),
					),
				}),
			};
		}
		case 'listBugs': {
			const statuses = context.getNodeParameter('bugStatuses', itemIndex, []) as string[];
			return {
				toolName: 'list-bugs',
				arguments: cleanArguments({
					workspaceId: getOptionalString(context, 'workspaceId', itemIndex),
					statuses,
					teamIds: splitCommaSeparated(getOptionalString(context, 'bugTeamIds', itemIndex)),
					assigneeIds: splitCommaSeparated(getOptionalString(context, 'bugAssigneeIds', itemIndex)),
				}),
			};
		}
		case 'reportBug': {
			return {
				toolName: 'report-bug',
				arguments: cleanArguments({
					workspaceId: getOptionalString(context, 'workspaceId', itemIndex),
					title: context.getNodeParameter('bugTitle', itemIndex) as string,
					description: getOptionalString(context, 'bugDescription', itemIndex),
					assigneeIds: splitCommaSeparated(getOptionalString(context, 'bugAssigneeIds', itemIndex)),
					teamIds: splitCommaSeparated(getOptionalString(context, 'bugTeamIds', itemIndex)),
				}),
			};
		}
		case 'updateBug': {
			return {
				toolName: 'update-bug',
				arguments: cleanArguments({
					taskId: context.getNodeParameter('bugTaskId', itemIndex) as string,
					workspaceId: getRequiredString(
						context,
						'workspaceId',
						itemIndex,
						'Workspace ID',
					),
					title: getOptionalString(context, 'bugTitle', itemIndex),
					description: getOptionalString(context, 'bugDescription', itemIndex),
					status: getOptionalString(context, 'bugUpdateStatus', itemIndex),
					assigneeIds: splitCommaSeparated(getOptionalString(context, 'bugAssigneeIds', itemIndex)),
					teamIds: splitCommaSeparated(getOptionalString(context, 'bugTeamIds', itemIndex)),
				}),
			};
		}
		case 'listMyTeams': {
			return {
				toolName: 'list-my-teams',
				arguments: cleanArguments({
					workspaceId: getOptionalString(context, 'workspaceId', itemIndex),
				}),
			};
		}
		case 'findTeamMember': {
			return {
				toolName: 'find-team-member',
				arguments: cleanArguments({
					query: context.getNodeParameter('memberQuery', itemIndex) as string,
				}),
			};
		}
		case 'rawToolCall': {
			const rawToolParameter = context.getNodeParameter('rawToolName', itemIndex) as
				| string
				| IDataObject;
			const toolName =
				typeof rawToolParameter === 'string'
					? rawToolParameter
					: String(rawToolParameter.value ?? '').trim();

			if (!toolName) {
				throw new ApplicationError('Raw Tool Name is required');
			}

			return {
				toolName,
				arguments: cleanArguments(parseRawArguments(context, itemIndex)),
			};
		}
		default:
			throw new ApplicationError(`Unsupported operation: ${operation}`);
	}
}

function normalizeContent(content?: IDataObject[]): IDataObject[] {
	if (!content) return [];

	return content.map((entry) => {
		const normalized: IDataObject = { ...entry };
		if (entry.type === 'text' && typeof entry.text === 'string') {
			try {
				normalized.textJson = JSON.parse(entry.text) as IDataObject[string];
			} catch {
				// keep plain text only
			}
		}
		return normalized;
	});
}

function getContentText(content: IDataObject[]): string | undefined {
	const textParts = content
		.filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
		.map((entry) => String(entry.text).trim())
		.filter((text) => text.length > 0);

	if (textParts.length === 0) {
		return undefined;
	}

	return textParts.join('\n\n');
}

async function getMcpTools(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const rawEndpoint = this.getNodeParameter('endpointUrl') as string;
	const endpointUrl = normalizeEndpointUrl(rawEndpoint);

	const result = await listTools(this, endpointUrl, paginationToken);
	const loweredFilter = filter?.toLowerCase().trim();

	const tools = loweredFilter
		? result.tools.filter((tool) => tool.name.toLowerCase().includes(loweredFilter))
		: result.tools;

	return {
		results: tools.map((tool) => ({
			name: tool.name,
			value: tool.name,
			description: tool.description,
		})),
		paginationToken: result.nextCursor,
	};
}

export class OneHorizon implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'One Horizon',
		name: 'oneHorizon',
		icon: { light: 'file:onehorizon.svg', dark: 'file:onehorizon.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Run One Horizon MCP tools from n8n',
		defaults: {
			name: 'One Horizon',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: MCP_CREDENTIAL_TYPE,
				required: true,
			},
		],
		properties: [
			{
				displayName: 'MCP Endpoint URL',
				name: 'endpointUrl',
				type: 'string',
				default: DEFAULT_MCP_ENDPOINT,
				required: true,
				description: 'One Horizon MCP endpoint URL',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'listPlannedWork',
				options: [
					{ name: 'Create Initiative', value: 'createInitiative' },
					{ name: 'Create Todo', value: 'createTodo' },
					{ name: 'Find Team Member', value: 'findTeamMember' },
					{ name: 'List Blockers', value: 'listBlockers' },
					{ name: 'List Bugs', value: 'listBugs' },
					{ name: 'List Completed Work', value: 'listCompletedWork' },
					{ name: 'List Initiatives', value: 'listInitiatives' },
					{ name: 'List My Teams', value: 'listMyTeams' },
					{ name: 'List Planned Work', value: 'listPlannedWork' },
					{ name: 'My Work Recap', value: 'myWorkRecap' },
					{ name: 'Raw Tool Call', value: 'rawToolCall' },
					{ name: 'Report Bug', value: 'reportBug' },
					{ name: 'Team Work Recap', value: 'teamWorkRecap' },
					{ name: 'Update Bug', value: 'updateBug' },
					{ name: 'Update Initiative', value: 'updateInitiative' },
					{ name: 'Update Todo', value: 'updateTodo' },
				],
			},
			{
				displayName: 'Workspace ID',
				name: 'workspaceId',
				type: 'string',
				default: '',
				description:
					'Workspace ID. Required for Update Todo, Update Initiative, and Update Bug operations.',
				displayOptions: {
					show: {
						operation: [
							'createTodo',
							'updateTodo',
							'listInitiatives',
							'createInitiative',
							'updateInitiative',
							'listBugs',
							'reportBug',
							'updateBug',
							'listMyTeams',
						],
					},
				},
			},
			{
				displayName: 'Team ID',
				name: 'teamId',
				type: 'string',
				default: '',
				description: 'Optional team ID filter',
				displayOptions: {
					show: {
						operation: ['listPlannedWork', 'listCompletedWork', 'listBlockers', 'teamWorkRecap'],
					},
				},
			},
			{
				displayName: 'User ID',
				name: 'userId',
				type: 'string',
				default: '',
				description: 'Optional user ID filter (requires Team ID for team-scoped queries)',
				displayOptions: {
					show: {
						operation: ['listPlannedWork', 'listCompletedWork', 'listBlockers'],
					},
				},
			},
			{
				displayName: 'Start Date',
				name: 'startDate',
				type: 'dateTime',
				default: '',
				description: 'Optional start date (ISO datetime)',
				displayOptions: {
					show: {
						operation: ['listCompletedWork', 'myWorkRecap', 'teamWorkRecap'],
					},
				},
			},
			{
				displayName: 'End Date',
				name: 'endDate',
				type: 'dateTime',
				default: '',
				description: 'Optional end date (ISO datetime)',
				displayOptions: {
					show: {
						operation: ['listCompletedWork', 'myWorkRecap', 'teamWorkRecap'],
					},
				},
			},
			{
				displayName: 'Include Initiatives',
				name: 'includeInitiatives',
				type: 'boolean',
				default: true,
				description: 'Whether to include initiative-scope tasks',
				displayOptions: {
					show: {
						operation: [
							'listPlannedWork',
							'listCompletedWork',
							'listBlockers',
							'myWorkRecap',
							'teamWorkRecap',
						],
					},
				},
			},
			{
				displayName: 'Todo Title',
				name: 'todoTitle',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						operation: ['createTodo'],
					},
				},
			},
			{
				displayName: 'Todo Task ID',
				name: 'todoTaskId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						operation: ['updateTodo'],
					},
				},
			},
			{
				displayName: 'Todo Topic',
				name: 'todoTopic',
				type: 'string',
				default: '',
				description: '1-3 words describing the purpose (for example API, UI, Auth)',
				required: true,
				displayOptions: {
					show: {
						operation: ['createTodo', 'updateTodo'],
					},
				},
			},
			{
				displayName: 'Todo Description',
				name: 'todoDescription',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				default: '',
				displayOptions: {
					show: {
						operation: ['createTodo', 'updateTodo'],
					},
				},
			},
			{
				displayName: 'Todo Status (Create)',
				name: 'todoCreateStatus',
				type: 'options',
				options: TASK_STATUS_OPTIONS,
				default: 'Planned',
				displayOptions: {
					show: {
						operation: ['createTodo'],
					},
				},
			},
			{
				displayName: 'Todo Status (Update)',
				name: 'todoUpdateStatus',
				type: 'string',
				default: '',
				placeholder: 'Completed',
				description: 'Optional status to set (Open, Planned, In Progress, In Review, Blocked, Completed)',
				displayOptions: {
					show: {
						operation: ['updateTodo'],
					},
				},
			},
			{
				displayName: 'Todo Completed At',
				name: 'todoCompletedAt',
				type: 'dateTime',
				default: '',
				description: 'Optional completion date',
				displayOptions: {
					show: {
						operation: ['createTodo', 'updateTodo'],
					},
				},
			},
			{
				displayName: 'Todo Initiative ID',
				name: 'todoInitiativeId',
				type: 'string',
				default: '',
				description: 'Optional initiative to link this todo to',
				displayOptions: {
					show: {
						operation: ['createTodo'],
					},
				},
			},
			{
				displayName: 'Todo Is New Feature',
				name: 'todoIsNewFeature',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['createTodo'],
					},
				},
			},
			{
				displayName: 'Todo Is Bug Fix',
				name: 'todoIsBugFix',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['createTodo'],
					},
				},
			},
			{
				displayName: 'Todo Is Refactor',
				name: 'todoIsRefactor',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['createTodo'],
					},
				},
			},
			{
				displayName: 'Todo Is Documentation',
				name: 'todoIsDocumentation',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['createTodo'],
					},
				},
			},
			{
				displayName: 'Todo Is Infrastructure',
				name: 'todoIsInfrastructure',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['createTodo'],
					},
				},
			},
			{
				displayName: 'Todo Is Test',
				name: 'todoIsTest',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['createTodo'],
					},
				},
			},
			{
				displayName: 'Initiative ID',
				name: 'initiativeId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						operation: ['updateInitiative'],
					},
				},
			},
			{
				displayName: 'Initiative Title',
				name: 'initiativeTitle',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						operation: ['createInitiative'],
					},
				},
			},
			{
				displayName: 'Initiative Description',
				name: 'initiativeDescription',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				default: '',
				displayOptions: {
					show: {
						operation: ['createInitiative', 'updateInitiative'],
					},
				},
			},
			{
				displayName: 'Initiative Status (Create)',
				name: 'initiativeCreateStatus',
				type: 'options',
				options: TASK_STATUS_OPTIONS,
				default: 'Planned',
				displayOptions: {
					show: {
						operation: ['createInitiative'],
					},
				},
			},
			{
				displayName: 'Initiative Status (Update)',
				name: 'initiativeUpdateStatus',
				type: 'string',
				default: '',
				placeholder: 'In Progress',
				displayOptions: {
					show: {
						operation: ['updateInitiative'],
					},
				},
			},
			{
				displayName: 'Initiative Parent ID',
				name: 'initiativeParentId',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['createInitiative', 'updateInitiative'],
					},
				},
			},
			{
				displayName: 'Initiative Team IDs',
				name: 'initiativeTeamIds',
				type: 'string',
				default: '',
				placeholder: 'team_1,team_2',
				description: 'Comma-separated team IDs',
				displayOptions: {
					show: {
						operation: ['listInitiatives', 'createInitiative', 'updateInitiative'],
					},
				},
			},
			{
				displayName: 'Initiative Assignee IDs',
				name: 'initiativeAssigneeIds',
				type: 'string',
				default: '',
				placeholder: 'user_1,user_2',
				description: 'Comma-separated assignee IDs',
				displayOptions: {
					show: {
						operation: ['listInitiatives', 'createInitiative', 'updateInitiative'],
					},
				},
			},
			{
				displayName: 'Initiative Taxonomy Label IDs',
				name: 'initiativeTaxonomyLabelIds',
				type: 'string',
				default: '',
				placeholder: 'label_1,label_2',
				description: 'Comma-separated taxonomy label IDs',
				displayOptions: {
					show: {
						operation: ['createInitiative', 'updateInitiative'],
					},
				},
			},
			{
				displayName: 'Include Hierarchy',
				name: 'includeHierarchy',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						operation: ['listInitiatives'],
					},
				},
			},
			{
				displayName: 'Initiative Statuses',
				name: 'initiativeStatuses',
				type: 'multiOptions',
				options: TASK_STATUS_OPTIONS,
				default: [],
				description: 'Optional status filters',
				displayOptions: {
					show: {
						operation: ['listInitiatives'],
					},
				},
			},
			{
				displayName: 'Bug Task ID',
				name: 'bugTaskId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						operation: ['updateBug'],
					},
				},
			},
			{
				displayName: 'Bug Title',
				name: 'bugTitle',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						operation: ['reportBug'],
					},
				},
			},
			{
				displayName: 'Bug Description',
				name: 'bugDescription',
				type: 'string',
				typeOptions: {
					rows: 3,
				},
				default: '',
				displayOptions: {
					show: {
						operation: ['reportBug', 'updateBug'],
					},
				},
			},
			{
				displayName: 'Bug Status (Update)',
				name: 'bugUpdateStatus',
				type: 'string',
				default: '',
				placeholder: 'In Progress',
				displayOptions: {
					show: {
						operation: ['updateBug'],
					},
				},
			},
			{
				displayName: 'Bug Team IDs',
				name: 'bugTeamIds',
				type: 'string',
				default: '',
				placeholder: 'team_1,team_2',
				description: 'Comma-separated team IDs',
				displayOptions: {
					show: {
						operation: ['listBugs', 'reportBug', 'updateBug'],
					},
				},
			},
			{
				displayName: 'Bug Assignee IDs',
				name: 'bugAssigneeIds',
				type: 'string',
				default: '',
				placeholder: 'user_1,user_2',
				description: 'Comma-separated assignee IDs',
				displayOptions: {
					show: {
						operation: ['listBugs', 'reportBug', 'updateBug'],
					},
				},
			},
			{
				displayName: 'Bug Statuses',
				name: 'bugStatuses',
				type: 'multiOptions',
				options: TASK_STATUS_OPTIONS,
				default: [],
				description: 'Optional status filters',
				displayOptions: {
					show: {
						operation: ['listBugs'],
					},
				},
			},
			{
				displayName: 'Team Member Query',
				name: 'memberQuery',
				type: 'string',
				default: '',
				required: true,
				description: 'Name or ID fragment to search for',
				displayOptions: {
					show: {
						operation: ['findTeamMember'],
					},
				},
			},
			{
				displayName: 'Raw Tool Name',
				name: 'rawToolName',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: {
					show: {
						operation: ['rawToolCall'],
					},
				},
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'getMcpTools',
							searchable: true,
							skipCredentialsCheckInRLC: true,
						},
					},
					{
						displayName: 'ID',
						name: 'id',
						type: 'string',
					},
				],
			},
			{
				displayName: 'Raw Arguments',
				name: 'rawArguments',
				type: 'json',
				typeOptions: {
					rows: 6,
				},
				default: '{\n  "example": "value"\n}',
				validateType: 'object',
				displayOptions: {
					show: {
						operation: ['rawToolCall'],
					},
				},
			},
		],
	};

	methods = {
		listSearch: {
			getMcpTools,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const node = this.getNode();

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const endpointUrl = normalizeEndpointUrl(
					this.getNodeParameter('endpointUrl', itemIndex, DEFAULT_MCP_ENDPOINT) as string,
				);
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const toolCall = getOperationToolCall(this, itemIndex);
				const result = await callTool(this, endpointUrl, toolCall);
				const content = normalizeContent(result.content);
				const text = getContentText(content);
				const isError = result.isError === true;

				returnData.push({
					json: {
						endpointUrl,
						operation,
						toolName: toolCall.toolName,
						toolArguments: toolCall.arguments,
						isError,
						text,
						content,
						metadata: {
							contentCount: content.length,
							contentTypes: content.map((entry) =>
								typeof entry.type === 'string' ? entry.type : 'unknown',
							),
						},
						rawResult: result as unknown as IDataObject,
					},
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error:
								error instanceof Error
									? error.message
									: 'Unknown One Horizon MCP error',
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				throw new NodeOperationError(
					node,
					error instanceof Error ? error.message : 'Unknown One Horizon MCP error',
					{ itemIndex },
				);
			}
		}

		return [returnData];
	}
}
