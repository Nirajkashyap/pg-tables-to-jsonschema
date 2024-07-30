import { promises as fsPromises } from 'fs';
import { join, dirname, basename } from 'path';
import { Client } from 'pg';
import { SchemaConverter } from './index';
import { IConfiguration } from './config'; // Assuming you have defined IConfiguration somewhere
import { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import { faker } from '@faker-js/faker';

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
    baseUrl: 'http://example.com/schemas',
    unwrap: false,
  },
};

// Function to clean/remove data from the relevant tables
async function cleanDatabase(client: Client, tableNames: string[]): Promise<void> {
  try {
    for (const tableName of tableNames) {
      if (!tableName.startsWith('auth.')) {
        await client.query(`DELETE FROM ${tableName}`);
        console.log(`Cleared data from ${tableName}`);
      }
    }
  } catch (err) {
    console.error('Error cleaning database:', err);
  }
}

// Function to fetch data from a table using the index
async function fetchDataFromTable(client: Client, tableName: string, index: number): Promise<any[]> {
  try {
    const result = await client.query(`SELECT id FROM ${tableName} LIMIT 1 OFFSET $1`, [index]);
    console.log(`Fetched data from ${tableName} using index ${index}`, result.rows);
    return result.rows;
  } catch (err) {
    console.error(`Error fetching data from ${tableName}:`, err);
    return [];
  }
}

// Function to generate data for a property
function generatePropertyData(property: JSONSchema7): any {
  if (property.enum) {
    // Return a random value from the enum array
    return faker.helpers.arrayElement(property.enum);
  } else if (property.format === 'uuid') {
    return faker.datatype.uuid();
  } else if (property.format === 'date-time') {
    return faker.date.recent().toISOString();
  } else if (property.type === 'string') {
    return faker.lorem.word();
  } else if (property.type === 'number') {
    return faker.datatype.number();
  } else if (property.type === 'integer') {
    return faker.datatype.number();
  } else if (property.type === 'boolean') {
    return faker.datatype.boolean();
  } else if (property.type === 'array' && property.items) {
    return [generatePropertyData(property.items as JSONSchema7)];
  } else if (property.type === 'object' && property.properties) {
    return generateFakeData(property as JSONSchema7, {}, new Client(config.pg), 1); // Pass 0 as default index for nested objects
  } else {
    return null;
  }
}

// Function to generate fake data
async function generateFakeData(schema: JSONSchema7, fakeDataMap: Record<string, any[]>, client: Client, index: number): Promise<any> {
  if (schema.title && schema.title.startsWith('auth.')) {
    // Skip generating fake data for schemas with title starting with 'auth.'
    return null;
  }

  const data: any = {};

  if (schema.properties) {
    for (const key in schema.properties) {
      const property = schema.properties[key] as any;

      // Skip properties with isGenerated set to true
      if (property.isGenerated) {
        continue;
      }

      if (property.foreignTable) {
        if (property.foreignTable === 'auth.users') {
          // Fetch data from auth.users table using index
          const foreignData = await fetchDataFromTable(client, 'auth.users', index);
          if (foreignData.length > 0) {
            data[key] = foreignData[0].id;
          }
        } else {
          const foreignData = fakeDataMap[property.foreignTable];
          if (foreignData && foreignData.length > 0) {
            // Return the primary key (assuming the primary key is `id`)
            data[key] = foreignData[index % foreignData.length].id;
          }
        }
      } else {
        data[key] = generatePropertyData(property);
      }
    }
  }

  return data;
}

// Function to insert fake data into PostgreSQL
async function insertFakeData(fakeDataMap: Record<string, any[]>): Promise<void> {
  const client = new Client(config.pg);

  try {
    await client.connect();

    for (const [tableName, dataArray] of Object.entries(fakeDataMap)) {
      for (const data of dataArray) {
        const columns = Object.keys(data).join(', ');
        const values = Object.values(data);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        const query = `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders})`;
        await client.query(query, values);
        console.log(`Inserted data into ${tableName}`);
      }
    }
  } catch (err) {
    console.error('Error inserting data:', err);
  } finally {
    await client.end();
  }
}

// Function to add foreign table schema
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

// Helper function to extract schema key from $id
function extractSchemaKeyFromId(id: string): string {
  const url = new URL(id);
  const pathParts = url.pathname.split('/').filter(Boolean);
  if (pathParts.length < 2) {
    throw new Error(`Invalid $id format: ${id}`);
  }
  const schemaKey = `${pathParts[pathParts.length - 2]}.${pathParts[pathParts.length - 1].replace('.json', '')}`;
  return schemaKey;
}

// Function to write schema files
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
  }
}

// Function to find foreign tables in a schema
function findForeignTables(schema: JSONSchema7): string[] {
  const foreignTables = new Set<string>();

  function traverseProperties(properties: { [key: string]: any }) {
    for (const key in properties) {
      const property = properties[key];

      if (property.foreignTable) {
        foreignTables.add(property.foreignTable);
      }

      if (property.properties) {
        traverseProperties(property.properties);
      }

      if (property.items) {
        if (Array.isArray(property.items)) {
          property.items.forEach((item: any) => {
            if (item.properties) {
              traverseProperties(item.properties);
            }
            if (item.foreignTable) {
              foreignTables.add(item.foreignTable);
            }
          });
        } else {
          if (property.items.properties) {
            traverseProperties(property.items.properties);
          }
          if (property.items.foreignTable) {
            foreignTables.add(property.items.foreignTable);
          }
        }
      }
    }
  }

  if (schema.properties) {
    traverseProperties(schema.properties);
  }

  return Array.from(foreignTables);
}

// Function to perform topological sort
function topologicalSort(schemasArray: JSONSchema7[]): string[] {
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

    const neighbors: any = adjList.get(node) || new Set();
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

// Main function
async function main() {
  const outputSchemas: JSONSchema7[] = await new SchemaConverter(config).convert();
  const updatedOutputSchemas = addForeignTableSchema(outputSchemas);
  await writeSchemaFiles(updatedOutputSchemas, config.output.outDir);
  const sortedSchemas = topologicalSort(updatedOutputSchemas);

  // console.log("Topologically sorted schemas:", JSON.stringify(sortedSchemas));

  const fakeDataMap: Record<string, any[]> = {};
  const client = new Client(config.pg);
  await client.connect();

  // Clean the database before inserting new fake data
  await cleanDatabase(client, sortedSchemas);

  for (const schemaTitle of sortedSchemas) {
    const schema = updatedOutputSchemas.find(s => s.title === schemaTitle);
    if (schema) {
      if (!schema.title.startsWith('auth.')) {
        const fakeDataArray = [];
        for (let i = 0; i < 10; i++) { // Generating 10 fake data entries for each schema
          fakeDataArray.push(await generateFakeData(schema, fakeDataMap, client, i));
        }
        fakeDataMap[schemaTitle] = fakeDataArray;
      }
    }
  }

  console.log("Generated fake data:", JSON.stringify(fakeDataMap, null, 2));

  await insertFakeData(fakeDataMap);
  await client.end();
}

// Example usage
main().catch(console.error);
