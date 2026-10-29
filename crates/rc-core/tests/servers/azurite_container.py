"""Create a container on Azurite (pip install azure-storage-blob):
python3 azurite_container.py [container] [endpoint]"""
import sys

from azure.core.exceptions import ResourceExistsError
from azure.storage.blob import BlobServiceClient

container = sys.argv[1] if len(sys.argv) > 1 else "rc-test"
endpoint = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:10000/devstoreaccount1"
conn = (
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
    "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;"
    f"BlobEndpoint={endpoint};"
)
try:
    BlobServiceClient.from_connection_string(conn).create_container(container)
    print(f"created {container}")
except ResourceExistsError:
    print(f"{container} exists")
