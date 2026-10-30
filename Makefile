PYTHON = python3
PYTHON_SOURCES = scalene/[a-z]*.py
C_SOURCES = src/source/get_line_atomic.cpp src/include/*.h* # src/source/libscalene.cpp 

mypy:
	# Requires: pip install mypy types-PyYAML
	-mypy $(PYTHON_SOURCES)

format: black isort clang-format

clang-format:
	-clang-format -i $(C_SOURCES) --style=google

isort:
	-isort $(PYTHON_SOURCES)

black:
	-black -l 79 $(PYTHON_SOURCES)

pkg:
	-rm -rf dist build *egg-info
	$(PYTHON) -m build

upload: pkg # to pypi
	$(PYTHON) -m twine upload dist/*
