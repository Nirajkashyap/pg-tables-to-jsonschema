import { promises as fsPromises } from 'fs';
import { join, dirname, basename } from 'path';
import { SchemaConverter } from './index';
import { IConfiguration }  from './config'; // Assuming you have defined IConfiguration somewhere

import { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import { AnyKindOfDictionary } from 'lodash';

const config: IConfiguration = {
  pg: {
    host: 'localhost',
    port: 54322,
    database: 'postgres',
    user: 'postgres',
    password: 'postgres',
  },
  input: {
    schemas: ['public','auth'],
    include: [],
    exclude: [],
  },
  output: {
    outDir: './schemas',
    indentSpaces: 2,
    defaultDescription: 'Generated by SchemaConverter',
    additionalProperties: true,
    baseUrl: 'http://example.com/schemas',
    unwrap: false
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

function addForeignTableSchema(jsonSchemas: any[]): any[] {
  const schemaMap = new Map<string, any>();

  // Create a map of $id to JSON schema for quick lookup
  jsonSchemas.forEach((schema) => {
    if (schema.$id) {
      const schemaKey = extractSchemaKeyFromId(schema.$id);
      // console.log(schemaKey);
      schemaMap.set(schemaKey, schema);
    }
  });

  // Iterate over the schemas and add foreignTableSchema when foreignTable is found
  return jsonSchemas.map((schema) => {
    if (schema.properties) {
      Object.keys(schema.properties).forEach((key) => {
        const property = schema.properties[key];
        if (property.foreignTable) {
          const foreignSchema = schemaMap.get(property.foreignTable);
          if (foreignSchema) {
            property.foreignTableSchema = foreignSchema;
          }
        }
      });
    }
    return schema;
  });
}


async function writeSchemaFiles(schemas: JSONSchema7[], baseOutputDir: string): Promise<void> {
    // console.log(JSON.stringify(schemas));
    for (const schema of schemas) {
      const schemaId = schema.$id;
      if (!schemaId) {
        console.error('Schema is missing $id property');
        continue;
      }
  
      // Extract the last folder path from the $id property
      const url = new URL(schemaId);
      const schemaPath = url.pathname;
      const schemaDir = dirname(schemaPath);
      const schemaName = basename(schemaPath, '.json');
      const outputDir = join(baseOutputDir, schemaDir);
  
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

// Example usage
(async () => {
  const outputSchemas: JSONSchema7[] = await new SchemaConverter(config).convert();
  const newO = addForeignTableSchema(outputSchemas);
  
  await writeSchemaFiles(newO, './');
})();
