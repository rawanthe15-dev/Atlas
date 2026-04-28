export interface ToolSchemaParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolSchemaParameter;
  properties?: Record<string, ToolSchemaParameter>;
  required?: string[];
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolSchemaParameter>;
      required?: string[];
    };
  };
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolSchema["function"]["parameters"];
  run(args: Record<string, any>): Promise<string>;
}

export function toSchema(tool: Tool): ToolSchema {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
