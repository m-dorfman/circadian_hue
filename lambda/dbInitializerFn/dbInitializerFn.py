import os
import json
import boto3
import psycopg
from aws_lambda_powertools.utilities import parameters

SECRET = json.loads(parameters.get_secret(os.environ.get("RDS_SECRET_NAME")))

lmda = boto3.client('lambda')

def create_table(connection):
    create_table = """
            CREATE TABLE lights_time_series (
            event_time      TIME   [ without time zone ] ,
            trigger_action  VARCHAR(10),
            light_id        VARCHAR(20)
            );
            """
    try:
        connection.cursor.execute(create_table)
        connection.cursor.close()
        connection.commit()
    except (Exception, psycopg.DatabaseError) as error:
        print(error)
    finally:
        if connection is not None:
            connection.close()


def lambda_handler(event, context):
    if str(event['RequestType']).lower() == 'create':
        connection = psycopg.connect(
            database=SECRET.get("engine"),
            user=SECRET.get("username"),
            password=SECRET.get("password"),
            host=SECRET.get("host"),
            port="5432",
        )
        create_table(connection)

        # self destruct
        lmda.delete_function(context.function_name)

    return
