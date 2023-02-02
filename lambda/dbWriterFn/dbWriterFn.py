import os
import json
import boto3
import psycopg
from aws_lambda_powertools.utilities import parameters

WRITE_QUEUE_URL = os.environ.get('WRITE_QUEUE_URL')

sqs = boto3.client('sqs')
SECRET = json.loads(parameters.get_secret(os.environ.get("RDS_SECRET_NAME")))

def insert_data(connection, payload, receipt_handle):
    insert_query = f"""
            INSERT INTO lights_time_series (
                event_time,
                trigger_action,
                light_id
            )
            VALUES (
                {payload['event_time']},
                {payload['trigger_action']},
                {payload['light_id']}
            )
    """
    try:
        connection.cursor.execute(insert_query)
        connection.cursor.close()
        connection.commit()
    except (Exception, psycopg.DatabaseError) as error:
        print(error)
    finally:
        if connection is not None:
            connection.close()
        sqs.delete_message(
            QueueUrl=WRITE_QUEUE_URL,
            ReceiptHandle=receipt_handle
        )

def lambda_handler(event, context):
    if str(event['RequestType']).lower() == 'create':
        connection = psycopg.connect(
            database=SECRET.get("engine"),
            user=SECRET.get("username"),
            password=SECRET.get("password"),
            host=SECRET.get("host"),
            port="5432",
        )

        # since this is an event there will only be one message
        payload = json.loads(event["Records"][0]["body"])
        receipt_handle = json.loads(event["Records"][0]["receiptHandle"])
        insert_data(connection, payload, receipt_handle)

    return
