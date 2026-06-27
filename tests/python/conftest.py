import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
import routes as note_trainer_routes


@pytest.fixture
def config_dir(tmp_path):
    return tmp_path


@pytest.fixture
def client(config_dir):
    app = FastAPI()
    note_trainer_routes.setup(app, {"config_dir": str(config_dir)})
    return TestClient(app)
