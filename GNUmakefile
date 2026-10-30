PYTHON = python3
PYTHON_SOURCES = scalene/[a-z]*.py
JS_SOURCES = scalene/scalene-gui/*.js
C_SOURCES = src/source/*.cpp src/include/*.h*

.PHONY: black clang-format prettier format upload

clean:
	rm -f scalene/*.so scalene/*.dylib
	rm -rf build dist *egg-info

mypy:
	# Requires: pip install mypy types-PyYAML
	-mypy $(PYTHON_SOURCES)

format: black clang-format prettier

clang-format:
	-clang-format -i $(C_SOURCES) --style=google

black:
	-black -l 79 $(PYTHON_SOURCES)

prettier:
	-npx prettier -w $(JS_SOURCES)

bdist:
	$(PYTHON) -m build --wheel
ifeq ($(shell uname -s),Linux)
	auditwheel repair dist/*.whl
	rm -f dist/*.whl
	mv wheelhouse/*.whl dist/
endif

sdist:
	$(PYTHON) -m build --sdist

upload: sdist bdist # to pypi
	$(PYTHON) -m twine upload dist/*
