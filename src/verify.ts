import { promises as fsPromises } from 'fs';
import { join, dirname, basename } from 'path';
import { SchemaConverter } from './index';
import { IConfiguration } from './config'; // Assuming you have defined IConfiguration somewhere
import { JSONSchema7, JSONSchema7Definition } from 'json-schema';

interface DependencyNode {
  table: string;
  dependencies: DependencyNode[];
}

interface DependencyMap {
  [key: string]: {
    dependencies: string[];
    dependents: string[];
  };
}

const config: IConfiguration = {
  pg: {
    host: 'localhost',
    port: 54322,
    database: 'postgres',
    user: 'postgres',
    password: 'postgres',
  },
  input: {
    schemas: ['public', 'auth'],
    include: [],
    exclude: [],
  },
  output: {
    outDir: './../output',
    indentSpaces: 2,
    defaultDescription: ' ',
    // additionalProperties: true,
    baseUrl: 'http://example.com/schemas',
    unwrap: false,
  },
};

function extractSchemaKeyFromId(id: string): string {
  const url = new URL(id);
  const pathParts = url.pathname.split('/').filter(Boolean);
  if (pathParts.length < 2) {
    throw new Error(`Invalid $id format: ${id}`);
  }
  const schemaKey = `${pathParts[pathParts.length - 2]}.${pathParts[pathParts.length - 1].replace('.json', '')}`;
  return schemaKey;
}

function addForeignTableSchema(jsonSchemas: JSONSchema7[]): JSONSchema7[] {
  const schemaMap = new Map<string, JSONSchema7>();

  // Create a map of $id to JSON schema for quick lookup
  jsonSchemas.forEach((schema) => {
    if (schema.$id) {
      const schemaKey = extractSchemaKeyFromId(schema.$id);
      if (schemaMap.has(schemaKey)) {
        console.error(`Duplicate schema key detected: ${schemaKey}`);
      } else {
        schemaMap.set(schemaKey, schema);
      }
    }
  });

  // Helper function to recursively process properties
  function processProperties(properties: { [key: string]: any }) {
    Object.keys(properties).forEach((key) => {
      const property = properties[key];

      // If foreignTable is found, add foreignTableSchema
      if (property.foreignTable) {
        const foreignSchema = schemaMap.get(property.foreignTable);
        if (foreignSchema) {
          property.foreignTableSchema = foreignSchema;
        }
      }

      // Recursively process nested properties if they exist
      if (property.properties) {
        processProperties(property.properties);
      }

      // Recursively process items if it's an array
      if (property.items) {
        if (Array.isArray(property.items)) {
          property.items.forEach((item: any) => {
            if (item.properties) {
              processProperties(item.properties);
            }
            if (item.foreignTable) {
              const foreignSchema = schemaMap.get(item.foreignTable);
              if (foreignSchema) {
                item.foreignTableSchema = foreignSchema;
              }
            }
          });
        } else {
          if (property.items.properties) {
            processProperties(property.items.properties);
          }
          if (property.items.foreignTable) {
            const foreignSchema = schemaMap.get(property.items.foreignTable);
            if (foreignSchema) {
              property.items.foreignTableSchema = foreignSchema;
            }
          }
        }
      }
    });
  }

  // Iterate over the schemas and process properties
  return jsonSchemas.map((schema) => {
    if (schema.properties) {
      processProperties(schema.properties);
    }
    return schema;
  });
}

async function writeSchemaFiles(schemas: JSONSchema7[], baseOutputDir: string): Promise<void> {
  for (const schema of schemas) {
    const schemaId = schema.$id;
    if (!schemaId) {
      console.error('Schema is missing $id property');
      continue;
    }

    // Extract the last folder path from the $id property
    const url = new URL(schemaId);
    const schemaPath = url.pathname;
    const schemaDirArray = dirname(schemaPath).split('/');
    const schemaDir = schemaDirArray.at(-1);
    const schemaName = basename(schemaPath, '.json');
    const outputDir = join(baseOutputDir, schemaDir!);

    // Ensure the output directory exists
    await fsPromises.mkdir(outputDir, { recursive: true });

    // Create TypeScript content
    const tsContent = `export const ${schemaName} = ${JSON.stringify(schema, null, 2)};\n`;

    // Construct the file path and write the content to the file
    const fileName = `${schemaName}.ts`;
    const filePath = join(outputDir, fileName);

    await fsPromises.writeFile(filePath, tsContent, 'utf8');
    console.log(`Schema file written: ${filePath}`);
  }
}


// Function to perform topological sort
function topologicalSort(schemasArray: any[]): string[] {
  const schemasMap: Record<string, any> = {};
  const adjList: Map<string, Set<string>> = new Map();
  const inDegree: Map<string, number> = new Map();
  const stack: string[] = [];
  const visited: Set<string> = new Set();
  const onStack: Set<string> = new Set();

  // Build the schema map and initialize in-degree and adjacency list
  schemasArray.forEach(schema => {
    const title = schema.title!;
    schemasMap[title] = schema;
    inDegree.set(title, 0);
    adjList.set(title, new Set());
  });

  // Build the graph
  schemasArray.forEach(schema => {
    const title = schema.title!;
    const foreignTables = findForeignTables(schema);
    foreignTables.forEach(foreignTable => {
      if (schemasMap[foreignTable]) {
        if (!adjList.has(foreignTable)) {
          adjList.set(foreignTable, new Set());
        }
        adjList.get(foreignTable)!.add(title);
        inDegree.set(title, (inDegree.get(title) || 0) + 1);
      }
    });
  });

  console.log("Adjacency List:", Array.from(adjList.entries()));
  console.log("In-Degree Map:", Array.from(inDegree.entries()));

  function detectCycle(node: string): boolean {
    if (onStack.has(node)) return true;
    if (visited.has(node)) return false;
    
    visited.add(node);
    onStack.add(node);
    
    const neighbors : any = adjList.get(node) || new Set();
    for (const neighbor of neighbors) {
      if (detectCycle(neighbor)) {
        return true;
      }
    }
    
    onStack.delete(node);
    stack.push(node);
    return false;
  }

  // Detect cycles and perform topological sort
  Object.keys(schemasMap).forEach(node => {
    if (!visited.has(node)) {
      if (detectCycle(node)) {
        throw new Error(`Cycle detected involving node: ${node}`);
      }
    }
  });

  // The stack contains nodes in reverse topological order
  return stack.reverse();
}

// Function to find all foreign table references
function findForeignTables(schema: any): string[] {
  const foreignTables: string[] = [];
  
  if (schema.properties) {
    Object.values(schema.properties).forEach((prop:any) => {
      if (typeof prop === 'object') {
        // Check for foreignTable in nested properties
        if (prop.foreignTable) {
          foreignTables.push(prop.foreignTable);
        }
        // Recursively check for foreignTable in nested objects
        if (prop.type === 'object' && prop.properties) {
          foreignTables.push(...findForeignTables(prop as any));
        }
        // Check for foreignTable in arrays of objects
        if (prop.type === 'array' && prop.items && typeof prop.items === 'object') {
          foreignTables.push(...findForeignTables(prop.items as any));
        }
      }
    });
  }
  
  return foreignTables;
}

// Example usage
(async () => {
  const outputSchemas: JSONSchema7[] = await new SchemaConverter(config).convert();
  // console.log(JSON.stringify(outputSchemas));
 
  // const dependencyTree = buildDependencyTree(outputSchemas);
  // console.log(JSON.stringify(dependencyTree, null, 2));
  // const resolvedOrder = resolveDependencies(dependencyTree);
  // console.log('Resolved Dependency Order:', resolvedOrder);
  const updatedOutputSchemas = addForeignTableSchema(outputSchemas);
  await writeSchemaFiles(updatedOutputSchemas, config.output.outDir);
  const sortedSchemas = topologicalSort(outputSchemas);
  console.log("Topologically sorted schemas:", JSON.stringify(sortedSchemas));
})();
