import json
import unicodedata
from pathlib import Path
import os

# Use an absolute path that we know exists and is accessible
file_path = Path(r"c:\Users\Acer\Desktop\ItaHover\Kaikki Data\italian_reverse_lookup_product_normalized.json")
if not file_path.exists():
    # Try relative if absolute fails in this environment
    file_path = Path(r"..\Desktop\ItaHover\Kaikki Data\italian_reverse_lookup_product_normalized.json")

print(f"Checking file: {file_path}")

try:
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    test_keys = ["parlerò", "troverà", "abbaiò", "abalienerà"]
    for tk in test_keys:
        if tk in data:
            print(f"Key '{tk}' found.")
            is_nfc = unicodedata.is_normalized('NFC', tk)
            is_nfd = unicodedata.is_normalized('NFD', tk)
            print(f"  NFC: {is_nfc}, NFD: {is_nfd}")
        else:
            found = False
            for k in data.keys():
                if unicodedata.normalize('NFC', k) == unicodedata.normalize('NFC', tk):
                    print(f"Key '{tk}' NOT found as-is, but found after NFC normalization: '{k}'")
                    print(f"  Original key in DB: NFC={unicodedata.is_normalized('NFC', k)}, NFD={unicodedata.is_normalized('NFD', k)}")
                    found = True
                    break
            if not found:
                print(f"Key '{tk}' not found at all (even with normalization).")
except Exception as e:
    print(f"Error: {e}")
