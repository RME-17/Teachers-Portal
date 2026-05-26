import chatterbox.tts_turbo as m
print('module file:', getattr(m, '__file__', None))
import inspect
for name,obj in inspect.getmembers(m):
    if inspect.isclass(obj):
        print('class', name, 'in', getattr(obj, '__module__', None))
