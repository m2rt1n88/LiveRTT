"""LiveRTT local embedded debugging services."""
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / ".deps"))
