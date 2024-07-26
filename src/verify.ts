import { promises as fsPromises } from 'fs';
import { join, dirname, basename } from 'path';
import { SchemaConverter } from './index';
import { IConfiguration } from './config'; // Assuming you have defined IConfiguration somewhere
import { JSONSchema7 } from 'json-schema';

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

function buildDependencyTree(schemas: JSONSchema7[]): { [key: string]: DependencyNode } {
  const dependencyMap: DependencyMap = {};

  schemas.forEach(schema => {
    const schemaTitle = schema.title as string;
    if (!dependencyMap[schemaTitle]) {
      dependencyMap[schemaTitle] = { dependencies: [], dependents: [] };
    }

    function extractDependencies(properties: { [key: string]: any }) {
      Object.values(properties).forEach(property => {
        if (property.foreignTable) {
          const foreignTable = property.foreignTable as string;
          if (!dependencyMap[foreignTable]) {
            dependencyMap[foreignTable] = { dependencies: [], dependents: [] };
          }
          dependencyMap[schemaTitle].dependencies.push(foreignTable);
          dependencyMap[foreignTable].dependents.push(schemaTitle);
        }

        if (property.type === 'object' && property.properties) {
          extractDependencies(property.properties);
        } else if (property.type === 'array' && property.items && property.items.type === 'object' && property.items.properties) {
          extractDependencies(property.items.properties);
        }
      });
    }

    extractDependencies(schema.properties as { [key: string]: any });
  });

  function buildTree(table: string, visited = new Set<string>()): DependencyNode | null {
    if (visited.has(table)) return null;
    visited.add(table);
    const node: DependencyNode = { table, dependencies: [] };
    dependencyMap[table].dependencies.forEach(dep => {
      const childNode = buildTree(dep, visited);
      if (childNode) {
        node.dependencies.push(childNode);
      }
    });
    return node;
  }

  const tree: { [key: string]: DependencyNode } = {};
  Object.keys(dependencyMap).forEach(table => {
    if (!dependencyMap[table].dependents.length) {
      tree[table] = buildTree(table) as DependencyNode;
    }
  });

  return tree;
}

// Example usage
(async () => {
  const outputSchemas: JSONSchema7[] = await new SchemaConverter(config).convert();
  // console.log(JSON.stringify(outputSchemas));
  const dependencyTree = buildDependencyTree(outputSchemas);
  console.log(JSON.stringify(dependencyTree, null, 2));
  const updatedOutputSchemas = addForeignTableSchema(outputSchemas);
  await writeSchemaFiles(updatedOutputSchemas, config.output.outDir);
})();
