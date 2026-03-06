import 'dotenv/config';
import { CreateTableCommand, DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';

const client = new DynamoDBClient({
    region: process.env.AWS_REGION || 'eu-west-2',
    endpoint: process.env.DYNAMODB_ENDPOINT,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local',
    },
});

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'cpv-booking';

async function dbSetup() {
    const { TableNames } = await client.send(new ListTablesCommand({}));

    if (TableNames?.includes(TABLE_NAME)) {
        console.log(`✅ Table "${TABLE_NAME}" already exists.`);
        return;
    }

    await client.send(
        new CreateTableCommand({
            TableName: TABLE_NAME,
            AttributeDefinitions: [
                { AttributeName: 'pk', AttributeType: 'S' },
                { AttributeName: 'sk', AttributeType: 'S' },
            ],
            KeySchema: [
                { AttributeName: 'pk', KeyType: 'HASH' },
                { AttributeName: 'sk', KeyType: 'RANGE' },
            ],
            BillingMode: 'PAY_PER_REQUEST',
        }),
    );

    console.log(`✅ Table "${TABLE_NAME}" created successfully.`);
    console.log(`   PK: pk (String) — entity type + user ID`);
    console.log(`   SK: sk (String) — entity-specific sort key`);
}

dbSetup().catch((err) => {
    console.error('❌ Setup failed:', err);
    process.exit(1);
});
