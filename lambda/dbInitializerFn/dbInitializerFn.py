import os
import json
import boto3
import psycopg3
from aws_lambda_powertools.utilities import parameters

SECRET = json.loads(parameters.get_secret(os.environ.get("RDS_SECRET_NAME")))

lmda = boto3.client('lambda')

def create_table():
    create_table = """
            CREATE TABLE queries(
            event_time    TIME   [ without time zone ] ,
            trigger_type  VARCHAR(10)
            light_id      VARCHAR(20)
            );
            """
    try:
        cursor.execute(create_table)
        cursor.close()
        connection.commit()
    except (Exception, psycopg2.DatabaseError) as error:
        print(error)
    finally:
        if connection is not None:
            connection.close()

def lambda_handler(event, context):
    if str(event['RequestType']).lower() == 'create':
        connection = psycopg3.connect(
            database=SECRET.get("engine"),
            user=SECRET.get("username"),
            password=SECRET.get("password"),
            host=SECRET.get("host"),
            port="5432",
        )
        create_table()

        lmda.delete_function(context.function_name)

    return