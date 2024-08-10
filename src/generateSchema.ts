import { promises as fsPromises } from 'fs';
import { join, dirname, basename } from 'path';
import { SchemaConverter } from './index';
import { IConfiguration } from './config'; // Assuming you have defined IConfiguration somewhere
import { JSONSchema7 } from 'json-schema';

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

// Function to add foreign table schemas to the schemas
function addForeignTableSchema(jsonSchemas: JSONSchema7[]): JSONSchema7[] {
  const schemaMap = new Map<string, JSONSchema7>();

  // Create a map of schema titles to schemas
  jsonSchemas.forEach((schema) => {
    const schemaId = schema.$id;
    if (schemaId) {
      const schemaKey = extractSchemaKeyFromId(schemaId);
      schemaMap.set(schemaKey, schema);
    }
  });

  function processProperties(properties: { [key: string]: any }) {
    Object.keys(properties).forEach((key) => {
      const property = properties[key];
      if (property.properties) {
        processProperties(property.properties);
      }

      if (property.foreignTable) {
        const foreignSchema = schemaMap.get(property.foreignTable);
        if (foreignSchema) {
          property.foreignTableSchema = foreignSchema;
        }
      }

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



// Main function
async function main() {
  const outputSchemas: JSONSchema7[] = await new SchemaConverter(config).convert();
  const updatedOutputSchemas = addForeignTableSchema(outputSchemas);
  await writeSchemaFiles(updatedOutputSchemas, config.output.outDir);

}

// Example usage
main().catch(console.error);
